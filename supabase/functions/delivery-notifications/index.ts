import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    const fromEmail = Deno.env.get("FROM_EMAIL");
    if (!supabaseUrl || !serviceRoleKey || !resendApiKey || !fromEmail) {
      throw new HttpError(500, "Delivery email is not configured. Set the Supabase and Resend function secrets.");
    }

    const authorization = request.headers.get("Authorization");
    const token = authorization?.replace(/^Bearer\s+/i, "").trim();
    if (!token) throw new HttpError(401, "Sign in to send order notifications.");

    let body: { orderId?: unknown; eventType?: unknown };
    try {
      body = await request.json();
    } catch {
      throw new HttpError(400, "An order ID is required.");
    }
    if (typeof body.orderId !== "string" || body.orderId.length < 1 || body.orderId.length > 100) {
      throw new HttpError(400, "A valid order ID is required.");
    }
    const eventType = body.eventType ?? "delivery_receipt";
    if (eventType !== "delivery_receipt" && eventType !== "customer_cancellation") {
      throw new HttpError(400, "Choose a valid order notification type.");
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData.user) throw new HttpError(401, "Your session is invalid.");

    const { data: caller, error: callerError } = await supabase
      .from("profiles")
      .select("id,email,full_name,role")
      .eq("id", userData.user.id)
      .maybeSingle();
    if (callerError) throw new HttpError(500, "Could not verify the account.");
    if (!caller) throw new HttpError(403, "A Farm Fresh account is required.");

    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select("id,user_id,seller_id,status,delivery_receipt,customer,cancelled_by,cancellation_reason,cancellation_reason_other,cancelled_at,payment_status")
      .eq("id", body.orderId)
      .maybeSingle();
    if (orderError) throw new HttpError(500, "Could not load the order notification.");
    if (!order) throw new HttpError(404, "Order not found.");

    if (eventType === "delivery_receipt") {
      if (caller.role !== "seller" || order.seller_id !== caller.id) {
        throw new HttpError(403, "Only the assigned seller can send this delivery receipt notification.");
      }
      if (order.status !== "Delivered" || !order.delivery_receipt) {
        throw new HttpError(409, "The order must be marked Delivered before receipt emails can be sent.");
      }
    } else {
      if (!["customer", "seller"].includes(caller.role) || order.user_id !== caller.id) {
        throw new HttpError(403, "Only the customer who placed this order can send its cancellation notification.");
      }
      if (order.status !== "Cancelled" || order.cancelled_by !== "customer") {
        throw new HttpError(409, "The order must be cancelled by its customer before cancellation emails can be sent.");
      }
    }

    const receipt = order.delivery_receipt;
    const eventKey = eventType === "delivery_receipt"
      ? receipt?.receiptId
      : `CANCEL-${order.id}`;
    if (typeof eventKey !== "string" || !eventKey) {
      throw new HttpError(500, "The order notification is missing its event ID.");
    }

    const { data: existingEmailRun, error: emailRunLookupError } = await supabase
      .from("order_notification_email_runs")
      .select("status,recipient_count,updated_at")
      .eq("order_id", order.id)
      .eq("event_type", eventType)
      .eq("event_key", eventKey)
      .maybeSingle();
    if (emailRunLookupError) throw new HttpError(500, "Could not check the notification email status.");
    if (existingEmailRun?.status === "sent") {
      return jsonResponse({ sent: existingEmailRun.recipient_count, alreadySent: true });
    }

    const { data: admins, error: adminsError } = await supabase
      .from("profiles")
      .select("email")
      .eq("role", "admin");
    if (adminsError) throw new HttpError(500, "Could not load owner notification recipients.");
    if (!admins?.length) throw new HttpError(500, "No owner administrator email account was found.");

    let sellerProfile = null;
    if (order.seller_id) {
      const { data, error: sellerProfileError } = await supabase
        .from("profiles")
        .select("email,full_name")
        .eq("id", order.seller_id)
        .maybeSingle();
      if (sellerProfileError) throw new HttpError(500, "Could not load the seller notification recipient.");
      sellerProfile = data;
      if (!sellerProfile) throw new HttpError(500, "The seller account for this order was not found.");
    }

    const recipients = new Map<string, { email: string; name: string }>();
    const addRecipient = (email: unknown, name: unknown) => {
      if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        throw new HttpError(500, "A valid email address is missing for an order notification account.");
      }
      const normalizedEmail = email.trim().toLowerCase();
      recipients.set(normalizedEmail, { email: normalizedEmail, name: String(name || "Farm Fresh user") });
    };

    addRecipient(order.customer?.email, order.customer?.fullName);
    if (sellerProfile) addRecipient(sellerProfile.email, sellerProfile.full_name);
    for (const admin of admins) addRecipient(admin.email, "Farm Fresh owner");

    const now = new Date();
    const nowIso = now.toISOString();
    if (existingEmailRun?.status === "sending"
        && now.getTime() - new Date(existingEmailRun.updated_at).getTime() < 5 * 60 * 1000) {
      throw new HttpError(409, "Order notification emails are already being sent.");
    }
    if (existingEmailRun) {
      const { data: claimedRun, error: claimError } = await supabase
        .from("order_notification_email_runs")
        .update({ status: "sending", updated_at: nowIso })
        .eq("order_id", order.id)
        .eq("event_type", eventType)
        .eq("event_key", eventKey)
        .eq("status", existingEmailRun.status)
        .eq("updated_at", existingEmailRun.updated_at)
        .select("order_id")
        .maybeSingle();
      if (claimError) throw new HttpError(500, "Could not claim the order notification email.");
      if (!claimedRun) throw new HttpError(409, "Order notification emails are already being sent.");
    } else {
      const { error: claimError } = await supabase
        .from("order_notification_email_runs")
        .insert({ order_id: order.id, event_type: eventType, event_key: eventKey, status: "sending", updated_at: nowIso });
      if (claimError?.code === "23505") {
        throw new HttpError(409, "Order notification emails are already being sent.");
      }
      if (claimError) throw new HttpError(500, "Could not claim the order notification email.");
    }

    const transactionId = escapeHtml(order.id);
    const reasonLabels: Record<string, string> = {
      ordered_by_mistake: "I ordered by mistake",
      no_longer_needed: "I no longer need these items",
      timing_issue: "The delivery or pickup timing does not work for me",
      payment_issue: "I have a payment issue",
    };
    const cancellationReason = order.cancellation_reason === "other"
      ? `Other: ${order.cancellation_reason_other || ""}`
      : reasonLabels[order.cancellation_reason] || "Not provided";
    const subject = eventType === "delivery_receipt"
      ? `Farm Fresh delivery receipt — ${order.id}`
      : `Farm Fresh order cancelled — ${order.id}`;
    const notificationContent = eventType === "delivery_receipt"
      ? `
          <h2>Delivery receipt issued</h2>
          <p>A seller marked your order as delivered. The receipt is available in your Farm Fresh account.</p>
          <p><strong>Receipt ID:</strong> ${escapeHtml(receipt.receiptId)}<br>
          <strong>Total:</strong> ₱${escapeHtml(receipt.totalAmount)}<br>
          <strong>Issued:</strong> ${escapeHtml(receipt.issuedAt)}</p>
        `
      : `
          <h2>Customer order cancellation</h2>
          <p>The customer cancelled this order. The order status and available stock have been updated.</p>
          <p><strong>Reason:</strong> ${escapeHtml(cancellationReason)}<br>
          <strong>Cancelled:</strong> ${escapeHtml(order.cancelled_at)}<br>
          <strong>Payment status:</strong> ${escapeHtml(order.payment_status)}</p>
          ${order.payment_status === "Paid" ? "<p>The payment is marked Paid and needs an owner refund review.</p>" : ""}
        `;
    const failedRecipients: string[] = [];

    try {
      for (const recipient of recipients.values()) {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resendApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: fromEmail,
            to: [recipient.email],
            subject,
            html: `
              <p>Hello ${escapeHtml(recipient.name)},</p>
              <p><strong>Transaction ID:</strong> ${transactionId}</p>
              ${notificationContent}
            `,
          }),
        });

        if (!response.ok) {
          const providerError = await response.text();
          console.error("Resend rejected an order notification email:", response.status, providerError);
          failedRecipients.push(recipient.email);
        }
      }
    } catch (error) {
      await supabase.from("order_notification_email_runs")
        .update({ status: "failed", updated_at: new Date().toISOString() })
        .eq("order_id", order.id)
        .eq("event_type", eventType)
        .eq("event_key", eventKey);
      throw error;
    }

    if (failedRecipients.length) {
      const { error: failureLogError } = await supabase
        .from("order_notification_email_runs")
        .update({ status: "failed", updated_at: new Date().toISOString() })
        .eq("order_id", order.id)
        .eq("event_type", eventType)
        .eq("event_key", eventKey);
      if (failureLogError) console.error("Could not save failed order notification email status:", failureLogError);
      throw new HttpError(502, `Order notification email could not be sent to ${failedRecipients.length} account(s). In-app notifications are still available.`);
    }

    const { error: sentLogError } = await supabase
      .from("order_notification_email_runs")
      .update({
        status: "sent",
        recipient_count: recipients.size,
        updated_at: new Date().toISOString(),
      })
      .eq("order_id", order.id)
      .eq("event_type", eventType)
      .eq("event_key", eventKey);
    if (sentLogError) {
      console.error("Emails were sent, but their notification status could not be saved:", sentLogError);
      throw new HttpError(500, "Order notification emails were sent, but their status could not be saved.");
    }
    return jsonResponse({ sent: recipients.size, alreadySent: false });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Unexpected delivery notification error.";
    console.error("Delivery notification request failed:", error);
    return jsonResponse({ error: message }, status);
  }
});
