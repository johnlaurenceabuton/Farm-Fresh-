import { createClient } from "npm:@supabase/supabase-js@2";

type SellerPreapplication = {
  id: string;
  full_name: string;
  email: string;
  phone: string;
  address: string;
  farm_name: string;
  farm_description: string;
  certificate_path: string;
  status: "pending" | "processing" | "approved" | "rejected";
  review_notes: string;
  approved_user_id: string | null;
  reviewed_by: string | null;
  processing_started_at: string | null;
  reviewed_at: string | null;
  created_at: string;
};

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

function requiredText(value: FormDataEntryValue | null, label: string, minLength: number, maxLength: number) {
  if (typeof value !== "string") throw new HttpError(400, `${label} is required.`);
  const text = value.trim();
  if (text.length < minLength || text.length > maxLength) {
    throw new HttpError(400, `${label} must be between ${minLength} and ${maxLength} characters.`);
  }
  return text;
}

function validateCertificate(file: File) {
  if (file.size < 1 || file.size > 5 * 1024 * 1024) {
    throw new HttpError(400, "Certificate must be no larger than 5 MB.");
  }

  const extension = file.name.split(".").pop()?.toLowerCase();
  const types = {
    pdf: { mime: "application/pdf", signature: [0x25, 0x50, 0x44, 0x46, 0x2d] },
    jpg: { mime: "image/jpeg", signature: [0xff, 0xd8, 0xff] },
    jpeg: { mime: "image/jpeg", signature: [0xff, 0xd8, 0xff] },
    png: { mime: "image/png", signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  };
  const type = extension ? types[extension as keyof typeof types] : null;
  if (!type || file.type !== type.mime) {
    throw new HttpError(400, "Certificate must be a PDF, JPG, or PNG file.");
  }

  return type;
}

async function consumeApplicationRateLimit(
  request: Request,
  supabase: ReturnType<typeof createClient>,
  serviceRoleKey: string,
) {
  const clientIp = request.headers.get("cf-connecting-ip")?.trim();
  if (!clientIp || clientIp.length > 64) {
    throw new HttpError(503, "Could not verify the request source. Please try again later.");
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(serviceRoleKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(clientIp),
  ));
  const ipHash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");

  const { data: allowed, error } = await supabase.rpc(
    "consume_seller_preapplication_attempt",
    { p_ip_hash: ipHash },
  );
  if (error) {
    console.error("Could not check seller application rate limit:", error);
    throw new HttpError(503, "Seller applications are temporarily unavailable. Please try again later.");
  }
  if (allowed !== true) {
    throw new HttpError(429, "Too many applications from this network. Please try again in an hour.");
  }
}

async function submitApplication(
  request: Request,
  supabase: ReturnType<typeof createClient>,
  serviceRoleKey: string,
) {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 6 * 1024 * 1024) {
    throw new HttpError(413, "Application upload must be no larger than 6 MB.");
  }

  const form = await request.formData();
  const website = form.get("website");
  if (typeof website !== "string" || website.trim()) {
    throw new HttpError(400, "Application could not be submitted.");
  }
  const startedAtValue = form.get("submission_started_at");
  const startedAt = typeof startedAtValue === "string" ? Number(startedAtValue) : NaN;
  if (!Number.isFinite(startedAt) || startedAt <= 0 || Date.now() - startedAt < 2000) {
    throw new HttpError(400, "Please wait a moment before submitting your application.");
  }
  await consumeApplicationRateLimit(request, supabase, serviceRoleKey);

  const fullName = requiredText(form.get("full_name"), "Full name", 2, 120);
  const email = requiredText(form.get("email"), "Email", 5, 254).toLowerCase();
  const phone = requiredText(form.get("phone"), "Phone number", 5, 40);
  const address = requiredText(form.get("address"), "Address", 3, 300);
  const farmName = requiredText(form.get("farm_name"), "Farm name", 2, 100);
  const farmDescription = form.get("farm_description");
  if (typeof farmDescription !== "string" || farmDescription.trim().length > 1000) {
    throw new HttpError(400, "Farm description must be no more than 1000 characters.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, "Enter a valid email address.");
  }

  const file = form.get("certificate");
  if (!(file instanceof File)) throw new HttpError(400, "A farmer certificate is required.");
  const type = validateCertificate(file);
  const fileBytes = new Uint8Array(await file.arrayBuffer());
  if (!type.signature.every((byte, index) => fileBytes[index] === byte)) {
    throw new HttpError(400, "The certificate contents do not match its file type.");
  }

  const applicationId = crypto.randomUUID();
  const certificatePath = `preapplications/${applicationId}/${crypto.randomUUID()}.${type.mime === "application/pdf" ? "pdf" : type.mime === "image/png" ? "png" : "jpg"}`;
  const { error: uploadError } = await supabase.storage
    .from("farmer-certificates")
    .upload(certificatePath, fileBytes, { contentType: type.mime, upsert: false });
  if (uploadError) {
    console.error("Could not store farmer certificate:", uploadError);
    throw new HttpError(500, "Could not securely store the farmer certificate. Please try again later.");
  }

  const { error: insertError } = await supabase.from("seller_preapplications").insert({
    id: applicationId,
    full_name: fullName,
    email,
    phone,
    address,
    farm_name: farmName,
    farm_description: farmDescription.trim(),
    certificate_path: certificatePath,
  });
  if (insertError) {
    const { error: cleanupError } = await supabase.storage
      .from("farmer-certificates")
      .remove([certificatePath]);
    if (cleanupError) console.error("Could not remove certificate after rejected application insert:", cleanupError);
    if (insertError.code === "23505") {
      throw new HttpError(409, "An application for this email is already awaiting review.");
    }
    console.error("Could not save farmer application:", insertError);
    throw new HttpError(500, "Could not save the farmer application. Please try again later.");
  }

  return jsonResponse({
    message: "Your application is submitted. If the owner approves it, an account invitation will be sent to your email.",
  }, 201);
}

async function requireAdmin(request: Request, supabase: ReturnType<typeof createClient>) {
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "Sign in as the owner administrator to review applications.");

  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData.user) throw new HttpError(401, "Your administrator session is invalid.");

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (profileError) throw new HttpError(500, `Could not verify administrator access: ${profileError.message}`);
  if (profile?.role !== "admin") throw new HttpError(403, "Owner administrator access is required.");
  return userData.user;
}

async function listApplications(supabase: ReturnType<typeof createClient>) {
  const { data, error } = await supabase
    .from("seller_preapplications")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new HttpError(500, `Could not load farmer applications: ${error.message}`);
  if (!data) throw new HttpError(500, "The seller application list was empty.");

  const applications = await Promise.all(data.map(async (application) => {
    let certificateUrl = null;
    if (application.status === "pending" || application.status === "processing") {
      const { data: signedUrl, error: signedUrlError } = await supabase.storage
        .from("farmer-certificates")
        .createSignedUrl(application.certificate_path, 900);
      if (signedUrlError) {
        throw new HttpError(500, `Could not create a private certificate link: ${signedUrlError.message}`);
      }
      certificateUrl = signedUrl.signedUrl;
    }
    return { ...application, certificate_url: certificateUrl };
  }));
  return jsonResponse({ applications });
}

async function claimApplication(
  supabase: ReturnType<typeof createClient>,
  applicationId: string,
  adminId: string,
  reviewNotes: string,
) {
  const now = new Date();
  const { data: claimed, error: claimError } = await supabase
    .from("seller_preapplications")
    .update({
      status: "processing",
      processing_started_at: now.toISOString(),
      reviewed_by: adminId,
      review_notes: reviewNotes,
    })
    .eq("id", applicationId)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();
  if (claimError) throw new HttpError(500, `Could not start seller approval: ${claimError.message}`);
  if (claimed) return claimed as SellerPreapplication;

  const { data: current, error: currentError } = await supabase
    .from("seller_preapplications")
    .select("*")
    .eq("id", applicationId)
    .maybeSingle();
  if (currentError) throw new HttpError(500, `Could not load seller application: ${currentError.message}`);
  if (!current) throw new HttpError(404, "Seller application not found.");
  if (current.status !== "processing") {
    throw new HttpError(409, "This application is no longer awaiting approval.");
  }

  const startedAt = Date.parse(current.processing_started_at || "");
  if (!Number.isFinite(startedAt) || now.getTime() - startedAt < 5 * 60 * 1000) {
    throw new HttpError(409, "This application is already being processed. Try again in a few minutes if no invitation arrives.");
  }

  const { data: reclaimed, error: reclaimError } = await supabase
    .from("seller_preapplications")
    .update({
      processing_started_at: now.toISOString(),
      reviewed_by: adminId,
      review_notes: reviewNotes,
    })
    .eq("id", applicationId)
    .eq("status", "processing")
    .eq("processing_started_at", current.processing_started_at)
    .select("*")
    .maybeSingle();
  if (reclaimError) throw new HttpError(500, `Could not retry seller approval: ${reclaimError.message}`);
  if (!reclaimed) throw new HttpError(409, "This application is already being processed. Try again shortly.");
  return reclaimed as SellerPreapplication;
}

async function approveApplication(
  supabase: ReturnType<typeof createClient>,
  application: SellerPreapplication,
  adminId: string,
) {
  let userId = application.approved_user_id as string | null;
  if (!userId) {
    const { data: existingProfiles, error: profileLookupError } = await supabase
      .from("profiles")
      .select("id")
      .eq("email", application.email)
      .limit(1);
    if (profileLookupError) {
      throw new HttpError(500, `Could not check for an existing account: ${profileLookupError.message}`);
    }

    if (existingProfiles.length) {
      const existingId = existingProfiles[0].id;
      const { data: existingUser, error: existingUserError } = await supabase.auth.admin.getUserById(existingId);
      if (existingUserError) throw new HttpError(500, `Could not inspect the existing account: ${existingUserError.message}`);
      if (!existingUser.user || existingUser.user.user_metadata?.seller_preapplication_id !== application.id) {
        const { error: resetError } = await supabase.from("seller_preapplications")
          .update({ status: "pending", processing_started_at: null })
          .eq("id", application.id)
          .eq("status", "processing");
        if (resetError) {
          throw new HttpError(500, `Could not restore the pending application: ${resetError.message}`);
        }
        throw new HttpError(409, "This email already has an account. Do not approve it as a new pre-registration seller.");
      }
      userId = existingId;
    } else {
      const siteUrl = Deno.env.get("SITE_URL");
      if (!siteUrl) throw new HttpError(500, "Account invitation is not configured (SITE_URL is missing).");
      const redirectUrl = new URL(siteUrl);
      if (!redirectUrl.pathname.endsWith(".html")) {
        redirectUrl.pathname = `${redirectUrl.pathname.replace(/\/?$/, "/")}index.html`;
      }
      const { data: invited, error: inviteError } = await supabase.auth.admin.inviteUserByEmail(
        application.email,
        {
          redirectTo: redirectUrl.toString(),
          data: {
            full_name: application.full_name,
            phone: application.phone,
            address: application.address,
            account_type: "seller",
            farm_name: application.farm_name,
            seller_preapplication_id: application.id,
          },
        },
      );
      if (inviteError) throw new HttpError(502, `Could not send the seller invitation: ${inviteError.message}`);
      if (!invited.user) throw new HttpError(502, "The invitation service did not return the new seller account.");
      userId = invited.user.id;
    }

    const { data: linkedApplication, error: linkError } = await supabase
      .from("seller_preapplications")
      .update({ approved_user_id: userId })
      .eq("id", application.id)
      .eq("status", "processing")
      .select("id")
      .maybeSingle();
    if (linkError) throw new HttpError(500, `Invitation was sent, but its account link could not be saved: ${linkError.message}`);
    if (!linkedApplication) throw new HttpError(409, "The invitation was sent, but the application changed before it could be linked.");
  }

  const { data: profile, error: roleError } = await supabase
    .from("profiles")
    .update({
      role: "seller",
      full_name: application.full_name,
      phone: application.phone,
      address: application.address,
    })
    .eq("id", userId)
    .select("id")
    .maybeSingle();
  if (roleError) throw new HttpError(500, `Invitation was sent, but seller access could not be granted: ${roleError.message}`);
  if (!profile) throw new HttpError(500, "Invitation was sent, but the account profile is not ready. Retry approval in a few minutes.");

  const { data: existingApplication, error: applicationLookupError } = await supabase
    .from("seller_applications")
    .select("id")
    .eq("user_id", userId)
    .eq("certificate_path", application.certificate_path)
    .limit(1)
    .maybeSingle();
  if (applicationLookupError) {
    throw new HttpError(500, `Seller access was granted, but the application record could not be checked: ${applicationLookupError.message}`);
  }

  const sellerApplication = {
    user_id: userId,
    farm_name: application.farm_name,
    farm_description: application.farm_description,
    certificate_path: application.certificate_path,
    status: "approved",
    review_notes: application.review_notes,
    reviewed_by: adminId,
    reviewed_at: new Date().toISOString(),
  };
  const { error: saveApplicationError } = existingApplication
    ? await supabase.from("seller_applications").update(sellerApplication).eq("id", existingApplication.id)
    : await supabase.from("seller_applications").insert(sellerApplication);
  if (saveApplicationError) {
    throw new HttpError(500, `Seller access was granted, but the approved application could not be saved: ${saveApplicationError.message}`);
  }

  const { error: finishError } = await supabase
    .from("seller_preapplications")
    .update({
      status: "approved",
      approved_user_id: userId,
      reviewed_by: adminId,
      reviewed_at: new Date().toISOString(),
      processing_started_at: null,
    })
    .eq("id", application.id)
    .eq("status", "processing");
  if (finishError) throw new HttpError(500, `Seller was approved, but the request status could not be finalized: ${finishError.message}`);

  return jsonResponse({ message: "Seller approved. An account invitation has been sent to the applicant." });
}

async function reviewApplication(
  request: Request,
  supabase: ReturnType<typeof createClient>,
  adminId: string,
) {
  const body = await request.json() as {
    application_id?: unknown;
    decision?: unknown;
    review_notes?: unknown;
  };
  const applicationId = typeof body.application_id === "string" ? body.application_id : "";
  const decision = body.decision;
  const reviewNotes = typeof body.review_notes === "string" ? body.review_notes.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(applicationId)) {
    throw new HttpError(400, "Invalid seller application.");
  }
  if (decision !== "approved" && decision !== "rejected") {
    throw new HttpError(400, "Choose approve or reject.");
  }
  if (reviewNotes.length > 1000) throw new HttpError(400, "Review notes are limited to 1000 characters.");

  if (decision === "rejected") {
    const { data, error } = await supabase
      .from("seller_preapplications")
      .update({
        status: "rejected",
        review_notes: reviewNotes,
        reviewed_by: adminId,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", applicationId)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (error) throw new HttpError(500, `Could not reject seller application: ${error.message}`);
    if (!data) throw new HttpError(409, "This application is no longer awaiting review.");
    return jsonResponse({ message: "Seller application rejected." });
  }

  const application = await claimApplication(supabase, applicationId, adminId, reviewNotes);
  return approveApplication(supabase, application, adminId);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      throw new HttpError(500, "Seller application service is not configured.");
    }
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    if (request.headers.get("content-type")?.includes("multipart/form-data")) {
      return await submitApplication(request, supabase, serviceRoleKey);
    }

    const body = await request.clone().json() as { action?: unknown };
    const admin = await requireAdmin(request, supabase);
    if (body.action === "list") return await listApplications(supabase);
    if (body.action === "review") return await reviewApplication(request, supabase, admin.id);
    throw new HttpError(400, "Unknown seller application action.");
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Unexpected seller application error.";
    console.error("Seller application request failed:", error);
    return jsonResponse({ error: message }, status);
  }
});
