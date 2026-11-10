"use strict";

const SUPABASE_URL = "https://arbgxvobvvhvxdlpyllp.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_KNHMVFhBzxnUPj66rlImvQ_hL1taoVQ";
if (!window.supabase?.createClient) {
    alert("⚠️ Supabase could not load. Check your internet connection and reload.");
    throw new Error("Supabase JavaScript client is unavailable.");
}
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const authLinkType = new URLSearchParams(window.location.hash.slice(1)).get("type");

/* =========================================================
   CONFIGURATION
   Change settings here instead of searching through the code.
   ========================================================= */
const CONFIG = {
    order: {
        preparationTime: "1 Week",
        minimumStock: 15,
        lowStockWarning: 30,
        minimumReservationDates: 2,
        maximumReservationDates: 3
    },

    orderTypes: {
        reserve: {
            label: "🚜 RESERVE",
            description: "Customer Harvests"
        },
        pickup: {
            label: "📦 PICK UP",
            description: "Customer picks up order"
        },
        delivery: {
            label: "🚚 DELIVERY",
            description: "We deliver to your address"
        }
    }
};

const PAYMENT_METHODS = {
    gcash: { label: "GCash", online: true },
    maya: { label: "Maya", online: true },
    bank: { label: "BPI", online: true },
    cashier: { label: "Pay in person / Cashier", online: false }
};

/* =========================================================
   DEFAULT CROPS
   Add a new crop here and the rest of the app handles it.
   ========================================================= */
const DEFAULT_CROPS = [
    { id: "potato",   name: "Potato",   type: "Root Crop", stockPerUnit: 100, available: 100, pricePerKg: 45 },
    { id: "carrot",   name: "Carrot",   type: "Root Crop", stockPerUnit: 100, available: 100, pricePerKg: 50 },
    { id: "radish",   name: "Radish",   type: "Root Crop", stockPerUnit: 100, available: 100, pricePerKg: 40 },
    { id: "beetroot", name: "Beetroot", type: "Root Crop", stockPerUnit: 100, available: 100, pricePerKg: 55 },
    { id: "cabbage",  name: "Cabbage",  type: "Vegetable", stockPerUnit: 50,  available: 50,  pricePerKg: 35 },
    { id: "pechay",   name: "Chinese Pechay", type: "Vegetable", stockPerUnit: 50, available: 50, pricePerKg: 30 },
    { id: "lettuce", name: "Iceberg Lettuce", type: "Vegetable", stockPerUnit: 50, available: 50, pricePerKg: 60 },
    { id: "romaine-lettuce", name: "Romaine Lettuce", type: "Vegetable", stockPerUnit: 50, available: 50, pricePerKg: 60 },
    { id: "green-leaf-lettuce", name: "Green Leaf Lettuce", type: "Vegetable", stockPerUnit: 50, available: 50, pricePerKg: 60 },
    { id: "red-leaf-lettuce", name: "Red Leaf Lettuce", type: "Vegetable", stockPerUnit: 50, available: 50, pricePerKg: 60 }
];

/* =========================================================
   APPLICATION STATE
   ========================================================= */
let currentUser = null;
let isAdmin = false;
let selectedCrops = [];
let crops = [];
let reservationDates = [];
let orders = [];
let paymentQrs = {};
let realtimeChannel = null;

/* =========================================================
   GENERIC HELPERS
   ========================================================= */
function $(id) {
    return document.getElementById(id);
}

function show(id) {
    const element = $(id);
    if (element) element.classList.remove("hidden");
}

function hide(id) {
    const element = $(id);
    if (element) element.classList.add("hidden");
}

function hideSections(ids) {
    ids.forEach(hide);
}

function showPasswordSection() {
    if (!currentUser) return;
    hideSections([
        "browse-section",
        "order-section",
        "summary-section",
        "receipt-section",
        "customer-orders-section",
        "admin-panel"
    ]);
    show("password-section");
    $("new-password").value = "";
    $("confirm-new-password").value = "";
    $("new-password").focus();
}

function cancelPasswordUpdate() {
    if (!currentUser) return;
    hide("password-section");
    if (isAdmin) showAdminPanel();
    else showBrowse();
}

async function handlePasswordUpdate(event) {
    event.preventDefault();
    if (!currentUser) return alert("⚠️ Sign in before setting a password.");

    const password = $("new-password").value;
    if (password.length < 8) {
        return alert("⚠️ Password must be at least 8 characters.");
    }
    if (password !== $("confirm-new-password").value) {
        return alert("⚠️ The passwords do not match.");
    }

    let error;
    try {
        ({ error } = await supabaseClient.auth.updateUser({ password }));
    } catch (requestError) {
        return alert(`⚠️ Could not update your password: ${requestError.message}`);
    }
    if (error) return alert(`⚠️ Could not update your password: ${error.message}`);

    $("password-form").reset();
    alert("✅ Your password has been set.");
    cancelPasswordUpdate();
}

function clone(data) {
    return JSON.parse(JSON.stringify(data));
}

function formatCurrency(amount) {
    return `₱${Number(amount || 0).toLocaleString("en-PH", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2
    })}`;
}

function formatDate(daysAhead) {
    const date = new Date();
    date.setDate(date.getDate() + Number(daysAhead));
    return date.toISOString().split("T")[0];
}

function escapeHTML(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

/* =========================================================
   DATA MANAGEMENT
   ========================================================= */
async function loadAllData() {
    const [productsResult, datesResult, ordersResult, paymentResult] = await Promise.all([
        supabaseClient.from("products").select("*").order("name"),
        supabaseClient.from("reservation_dates").select("available_on").order("available_on"),
        supabaseClient.from("orders").select("*").order("created_at", { ascending: false }),
        supabaseClient.from("payment_qrs").select("method,image_data")
    ]);

    for (const result of [productsResult, datesResult, ordersResult, paymentResult]) {
        if (result.error) throw result.error;
    }

    crops = productsResult.data.map(product => ({
        id: product.id,
        name: product.name,
        type: product.type,
        stockPerUnit: product.stock_per_unit,
        available: Number(product.stock_kg),
        pricePerKg: Number(product.price_per_kg),
        image: product.image || ""
    }));
    reservationDates = datesResult.data.map(row => row.available_on);
    orders = ordersResult.data.map(order => ({
        id: order.id,
        customer: order.customer,
        orderType: order.order_type,
        paymentMethod: order.payment_method,
        paymentStatus: order.payment_status,
        paymentReference: order.payment_reference,
        reservationDate: order.reservation_date || "N/A",
        items: order.items,
        totalQuantity: Number(order.total_quantity),
        totalAmount: Number(order.total_amount),
        status: order.status,
        deliveryReceipt: order.delivery_receipt,
        customerReceivedAt: order.customer_received_at,
        deliveredAt: order.delivered_at,
        createdAt: order.created_at,
        userId: order.user_id
    }));
    paymentQrs = Object.fromEntries(
        paymentResult.data.map(row => [row.method, row.image_data])
    );
}

function normalizeReservationDates() {
    reservationDates = [...new Set(
        reservationDates
            .filter(Boolean)
            .map(date => String(date))
    )].sort();
}

/* =========================================================
   AUTHENTICATION
   ========================================================= */
function showSignup() {
    show("signup-form");
    hide("login-form");
    $("fullName").focus();
}

function showLogin() {
    show("login-form");
    hide("signup-form");
}

function togglePasswordVisibility() {
    const field = $("login-password");
    field.type = field.type === "password" ? "text" : "password";
}

async function handleSignup(event) {
    event.preventDefault();

    const fullName = $("fullName").value.trim();
    const email = $("email").value.trim().toLowerCase();
    const phone = $("phone").value.trim();
    const address = $("address").value.trim();
    const password = $("password").value;

    if (!fullName || !email || !phone || !address || !password) {
        return alert("⚠️ Please complete all required fields.");
    }

    if (password.length < 8) {
        return alert("⚠️ Password must be at least 8 characters.");
    }

    let data, error;
    try {
        ({ data, error } = await supabaseClient.auth.signUp({
            email,
            password,
            options: { data: { full_name: fullName, phone, address } }
        }));
    } catch (requestError) {
        return alert(`⚠️ Account creation failed: ${requestError.message}`);
    }
    if (error) return alert(`⚠️ Could not create account: ${error.message}`);
    if (!data.session) {
        return alert("✅ Account created. Check your email to confirm the account, then log in.");
    }

    $("login-email").value = email;
    await completeSupabaseLogin(data.session.user);
}

async function handleLogin(event) {
    event.preventDefault();

    const email = $("login-email").value.trim().toLowerCase();
    const password = $("login-password").value;
    let data, error;
    try {
        ({ data, error } = await supabaseClient.auth.signInWithPassword({ email, password }));
    } catch (requestError) {
        return alert(`❌ Login failed: ${requestError.message}`);
    }
    if (error) return alert(`❌ Login failed: ${error.message}`);
    await completeSupabaseLogin(data.user);
}

async function handlePasswordReset() {
    const email = $("login-email").value.trim().toLowerCase();
    if (!email) return alert("Enter your account email address first.");

    let error;
    try {
        ({ error } = await supabaseClient.auth.resetPasswordForEmail(email, {
            redirectTo: `${window.location.origin}${window.location.pathname}`
        }));
    } catch (requestError) {
        return alert(`⚠️ Could not request a password reset: ${requestError.message}`);
    }
    if (error) return alert(`⚠️ Could not request a password reset: ${error.message}`);
    alert("If an account exists for that email, a password reset link will be sent.");
}

async function completeSupabaseLogin(authUser) {
    let profile, error;
    try {
        ({ data: profile, error } = await supabaseClient
            .from("profiles")
            .select("id,email,full_name,phone,address,role")
            .eq("id", authUser.id)
            .single());
    } catch (requestError) {
        await supabaseClient.auth.signOut();
        return alert(`⚠️ Could not load your account profile: ${requestError.message}`);
    }
    if (error) {
        await supabaseClient.auth.signOut();
        return alert(`⚠️ Could not load your account profile: ${error.message}`);
    }

    currentUser = {
        id: profile.id,
        email: profile.email,
        fullName: profile.full_name,
        phone: profile.phone,
        address: profile.address
    };
    isAdmin = profile.role === "admin";
    await postLoginSetup();
}

async function postLoginSetup() {
    setAuthAtmosphere(false);
    try {
        await loadAllData();
    } catch (error) {
        console.error("Could not load Supabase data:", error);
        alert(`⚠️ Could not load shop data: ${error.message}`);
        return;
    }

    hide("auth-section");
    show("nav-area");
    updateAdminViewToggle();

    $("user-greeting").textContent = `👤 ${currentUser.fullName}`;
    subscribeToRealtimeUpdates();
    if (isAdmin) showAdminPanel();
    else showBrowse();
}

function subscribeToRealtimeUpdates() {
    if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);
    realtimeChannel = supabaseClient
        .channel(`farm-fresh-${currentUser.id}`)
        .on("postgres_changes", { event: "*", schema: "public", table: "products" }, refreshShopData)
        .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, refreshShopData)
        .on("postgres_changes", { event: "*", schema: "public", table: "reservation_dates" }, refreshShopData)
        .on("postgres_changes", { event: "*", schema: "public", table: "payment_qrs" }, refreshShopData)
        .subscribe((status, error) => {
            if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
                console.error("Realtime connection failed:", error || status);
            }
        });
}

let refreshInProgress = false;
async function refreshShopData() {
    if (!currentUser || refreshInProgress) return;
    refreshInProgress = true;
    try {
        await loadAllData();
        if (isAdmin && !$("admin-panel").classList.contains("hidden")) showAdminPanel();
        else if (!$("browse-section").classList.contains("hidden")) renderCrops();
        else if (!$("customer-orders-section").classList.contains("hidden")) renderCustomerOrders();
    } catch (error) {
        console.error("Realtime data refresh failed:", error);
    } finally {
        refreshInProgress = false;
    }
}

async function logout() {
    if (!confirm("🔓 Logout?")) return;

    let error;
    try {
        ({ error } = await supabaseClient.auth.signOut());
    } catch (requestError) {
        return alert(`⚠️ Could not log out: ${requestError.message}`);
    }
    if (error) return alert(`⚠️ Could not log out: ${error.message}`);
    if (realtimeChannel) {
        await supabaseClient.removeChannel(realtimeChannel);
        realtimeChannel = null;
    }
    currentUser = null;
    isAdmin = false;
    selectedCrops = [];

    hide("nav-area");
    hide("admin-view-toggle");
    show("auth-section");
    setAuthAtmosphere(true);
    hide("header-note");
    hide("admin-panel");

    hideSections([
        "browse-section",
        "order-section",
        "summary-section",
        "receipt-section",
        "customer-orders-section",
        "password-section"
    ]);

    $("login-email").value = "";
    $("login-password").value = "";
    $("fullName").value = "";
    $("email").value = "";
    $("phone").value = "";
    $("address").value = "";
    $("password").value = "";

    hide("signup-form");
    hide("login-form");
    showLogin();
    hide("header-note");
}

/* =========================================================
   CUSTOMER — BROWSE CROPS
   ========================================================= */
function showBrowse() {
    hideSections(["order-section", "summary-section", "receipt-section", "admin-panel", "customer-orders-section", "password-section"]);
    show("browse-section");
    show("header-note");
    renderCrops();
}

function renderCrops() {
    const list = $("crops-list");

    const availableCrops = crops.filter(
        crop => crop.available > CONFIG.order.minimumStock
    );

    if (!availableCrops.length) {
        list.innerHTML = `
            <p class="empty-message">
                No vegetables are available at this time.
            </p>
        `;
        return;
    }

    list.innerHTML = availableCrops.map(crop => {
        const lowStock = crop.available <= CONFIG.order.lowStockWarning
            ? `<span class="low-stock">⚠️ Low Stock</span>`
            : "";

        const icon = getVegetableIcon(crop.id);
        const imageMarkup = crop.image
            ? `<img class="vegetable-photo" src="${escapeHTML(crop.image)}" alt="${escapeHTML(crop.name)}">`
            : `<div class="vegetable-icon">${icon}</div>`;

        return `
            <div
                class="vegetable-card"
                data-crop-id="${escapeHTML(crop.id)}"
                tabindex="0"
                role="button"
                aria-label="View price for ${escapeHTML(crop.name)}"
                onclick="toggleVegetablePrice('${escapeHTML(crop.id)}')"
                onkeydown="if(event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleVegetablePrice('${escapeHTML(crop.id)}'); }"
            >
                ${imageMarkup}
                <h3>${escapeHTML(crop.name)}</h3>
                <div class="vegetable-type">${escapeHTML(crop.type)}</div>

                <div class="vegetable-price">
                    ${formatCurrency(crop.pricePerKg)} / kg
                </div>

                <div class="click-hint">Hover or click to see price</div>

                <div class="note">
                    Available: ${crop.available}kg ${lowStock}
                </div>

                <input
                    type="number"
                    min="0"
                    max="${crop.available}"
                    value="0"
                    class="qty-input"
                    data-id="${escapeHTML(crop.id)}"
                    aria-label="Quantity of ${escapeHTML(crop.name)}"
                    onclick="event.stopPropagation()"
                >
            </div>
        `;
    }).join("");
}

function getVegetableIcon(id) {
    const icons = {
        potato: "🥔",
        carrot: "🥕",
        radish: "🌱",
        beetroot: "🫜",
        cabbage: "🥬",
        pechay: "🥬",
        lettuce: "🥬"
    };

    return icons[id] || "🥦";
}

function toggleVegetablePrice(cropId) {
    const card = document.querySelector(
        `.vegetable-card[data-crop-id="${CSS.escape(cropId)}"]`
    );

    if (!card) return;

    card.classList.toggle("active");
}
function goToSelection() {
    selectedCrops = [];

    document.querySelectorAll(".qty-input").forEach(input => {
        const crop = crops.find(item => item.id === input.dataset.id);
        const quantity = Math.floor(Number(input.value));

        if (!crop || !Number.isFinite(quantity) || quantity <= 0) return;

        const safeQuantity = Math.min(quantity, crop.available);

        selectedCrops.push({
            cropId: crop.id,
            cropName: crop.name,
            quantity: safeQuantity,
            pricePerKg: crop.pricePerKg
        });
    });

    if (!selectedCrops.length) {
        return alert("⚠️ Select at least one crop.");
    }

    renderSelectedItems();
    renderReservationDates();

    document.querySelectorAll('input[name="orderType"]').forEach(
        radio => radio.checked = false
    );
    document.querySelectorAll('input[name="paymentMethod"]').forEach(
        radio => radio.checked = false
    );

    hide("date-picker");
    hide("delivery-address");
    updatePaymentDetails();

    hide("browse-section");
    show("order-section");
}

function renderSelectedItems() {
    $("selected-items").innerHTML = selectedCrops.map(item => `
        <p>
            ✅ ${escapeHTML(item.cropName)}
            — ${item.quantity}kg × ${formatCurrency(item.pricePerKg)}
            = <strong>${formatCurrency(item.quantity * item.pricePerKg)}</strong>
        </p>
    `).join("");
}

function renderReservationDates() {
    $("dates-list").innerHTML = reservationDates.length
        ? reservationDates.map(date => `
            <label>
                <input type="radio" name="resDate" value="${escapeHTML(date)}">
                ${escapeHTML(date)}
            </label>
        `).join("")
        : "<p>No reservation dates are currently available.</p>";
}

/* =========================================================
   ORDER OPTIONS
   ========================================================= */
function renderOrderOptions() {
    $("order-options").innerHTML = Object.entries(CONFIG.orderTypes)
        .map(([value, option]) => `
            <label>
                <input
                    type="radio"
                    name="orderType"
                    value="${escapeHTML(value)}"
                    onchange="toggleOptions()"
                >
                ${option.label} (${option.description})
            </label>
        `)
        .join("");
}

function renderPaymentOptions() {
    $("payment-options").innerHTML = Object.entries(PAYMENT_METHODS)
        .map(([value, method]) => `
            <label class="payment-option">
                <input type="radio" name="paymentMethod" value="${value}" onchange="updatePaymentDetails()">
                <span>${escapeHTML(method.label)}</span>
            </label>
        `)
        .join("");
}

function getSelectedPaymentMethod() {
    return document.querySelector('input[name="paymentMethod"]:checked')?.value || null;
}

function getPaymentMethodLabel(methodId) {
    return PAYMENT_METHODS[methodId]?.label || "Not selected";
}

function updatePaymentDetails() {
    const methodId = getSelectedPaymentMethod();
    const details = $("payment-details");

    if (!methodId || !PAYMENT_METHODS[methodId]) {
        details.innerHTML = "";
        hide("payment-details");
        return;
    }

    show("payment-details");

    if (!PAYMENT_METHODS[methodId].online) {
        details.innerHTML = `
            <div class="payment-detail-copy">
                <strong>Pay in person at the cashier</strong>
                <p>Your order receipt will show the amount due. Payment is recorded as due until the cashier confirms collection.</p>
                <p><strong>Amount due:</strong> ${formatCurrency(calculateTotals().amount)}</p>
            </div>
        `;
        return;
    }

    const qrImage = paymentQrs[methodId];
    details.innerHTML = `
        ${qrImage
            ? `<img class="payment-qr-preview" src="${escapeHTML(qrImage)}" alt="${escapeHTML(PAYMENT_METHODS[methodId].label)} merchant QR code">`
            : `<div class="payment-qr-preview payment-qr-empty">Admin QR not uploaded</div>`}
        <div class="payment-detail-copy">
            <strong>Pay with ${escapeHTML(PAYMENT_METHODS[methodId].label)}</strong>
            <p>Scan the merchant QR and enter this exact amount in your payment app:</p>
            <p><strong class="payment-total-due">${formatCurrency(calculateTotals().amount)}</strong></p>
            ${qrImage
                ? '<p>Payment will remain pending until the admin verifies the transfer.</p>'
                : '<p>Online payment is unavailable until the admin uploads this method’s QR code.</p>'}
            <label for="payment-reference">Payment reference (if available)</label>
            <input id="payment-reference" type="text" maxlength="100" placeholder="Enter transaction/reference number">
        </div>
    `;
}

function renderAdminPaymentQrs() {
    const container = $("admin-payment-qrs");
    if (!container) return;

    container.innerHTML = Object.entries(PAYMENT_METHODS)
        .filter(([, method]) => method.online)
        .map(([methodId, method]) => `
            <div class="payment-qr-admin-card">
                ${paymentQrs[methodId]
                    ? `<img src="${escapeHTML(paymentQrs[methodId])}" alt="${escapeHTML(method.label)} QR preview">`
                    : '<div class="admin-qr-placeholder">No QR yet</div>'}
                <label>
                    ${escapeHTML(method.label)} QR
                    <input type="file" accept="image/*" onchange="handlePaymentQrUpload('${methodId}', this)">
                </label>
            </div>
        `)
        .join("");
}

async function handlePaymentQrUpload(methodId, input) {
    const file = input.files?.[0];
    if (!file || !PAYMENT_METHODS[methodId]?.online) return;

    try {
        const qrImage = await resizeImageForStorage(file, 640, 640, false, "image/png");
        const { error } = await supabaseClient.from("payment_qrs").upsert({
            method: methodId,
            image_data: qrImage,
            updated_at: new Date().toISOString()
        });
        if (error) throw error;
        paymentQrs[methodId] = qrImage;

        renderAdminPaymentQrs();
        updatePaymentDetails();
        alert("✅ Payment QR saved to the shared shop database.");
    } catch (error) {
        alert(`⚠️ ${error.message}`);
    } finally {
        input.value = "";
    }
}

function toggleOptions() {
    const selected = document.querySelector('input[name="orderType"]:checked');
    const type = selected?.value;

    show("date-picker");
    hide("delivery-address");

    if (type !== "reserve") hide("date-picker");
    if (type === "delivery") show("delivery-address");
}

/* =========================================================
   ORDER SUMMARY
   ========================================================= */
function getSelectedOrderType() {
    return document.querySelector('input[name="orderType"]:checked')?.value || null;
}

function calculateTotals() {
    return selectedCrops.reduce(
        (totals, item) => {
            totals.quantity += item.quantity;
            totals.amount += item.quantity * item.pricePerKg;
            return totals;
        },
        { quantity: 0, amount: 0 }
    );
}

function getDeliveryAddress(orderType) {
    if (orderType !== "delivery") return currentUser.address;

    return $("deliv-address").value.trim() || currentUser.address;
}

function showOrderSummary() {
    const orderType = getSelectedOrderType();
    const paymentMethod = getSelectedPaymentMethod();

    if (!orderType) {
        return alert("⚠️ Select an order option.");
    }

    if (orderType === "reserve" && !document.querySelector('input[name="resDate"]:checked')) {
        return alert("⚠️ Choose an available reservation date.");
    }

    if (!paymentMethod) {
        return alert("⚠️ Select a payment method.");
    }

    if (PAYMENT_METHODS[paymentMethod].online && !paymentQrs[paymentMethod]) {
        return alert(`⚠️ The admin has not uploaded a ${PAYMENT_METHODS[paymentMethod].label} QR code yet. Choose another method or contact the store.`);
    }

    if (!selectedCrops.length) {
        return alert("⚠️ No crops have been selected.");
    }

    if (orderType === "reserve" && !document.querySelector('input[name="resDate"]:checked')) {
        return alert("⚠️ Please select a reservation date.");
    }

    const selectedDate =
        document.querySelector('input[name="resDate"]:checked')?.value || "N/A";

    const deliveryAddress = getDeliveryAddress(orderType);
    const totals = calculateTotals();
    const typeInfo = CONFIG.orderTypes[orderType];

    $("summary-content").innerHTML = `
        <p><strong>Order Type:</strong> ${typeInfo.label}</p>
        <hr>

        <p><strong>Items:</strong></p>
        ${selectedCrops.map(item => `
            • ${escapeHTML(item.cropName)}:
            ${item.quantity}kg × ${formatCurrency(item.pricePerKg)}
            = ${formatCurrency(item.quantity * item.pricePerKg)}
        `).join("<br>")}

        <hr>

        <p><strong>Total Quantity:</strong> ${totals.quantity} kg</p>
        <p><strong>Total Amount:</strong> ${formatCurrency(totals.amount)}</p>
        <p><strong>Payment Method:</strong> ${escapeHTML(getPaymentMethodLabel(paymentMethod))}</p>
        <p><strong>Payment Status:</strong> ${PAYMENT_METHODS[paymentMethod].online ? "Awaiting verification" : "Due at cashier"}</p>
        <p><strong>Payment Reference:</strong> ${escapeHTML($("payment-reference")?.value.trim() || "Not provided")}</p>
        <p><strong>Reservation Date:</strong> ${escapeHTML(selectedDate)}</p>
        <p><strong>Address:</strong> ${escapeHTML(deliveryAddress)}</p>
        <p><strong>Preparation Time:</strong> ${escapeHTML(CONFIG.order.preparationTime)}</p>
    `;

    hide("order-section");
    show("summary-section");
}

/* =========================================================
   CONFIRM ORDER
   ========================================================= */
async function confirmOrder() {
    const orderType = getSelectedOrderType();
    const paymentMethod = getSelectedPaymentMethod();

    if (!orderType || !paymentMethod || !currentUser || !selectedCrops.length) {
        return alert("⚠️ The order information is incomplete.");
    }

    if (PAYMENT_METHODS[paymentMethod].online && !paymentQrs[paymentMethod]) {
        return alert("⚠️ This online payment method is not configured yet.");
    }

    const selectedDate =
        document.querySelector('input[name="resDate"]:checked')?.value || null;
    const paymentReference = $("payment-reference")?.value.trim() || "";
    let transactionId, error;
    try {
        ({ data: transactionId, error } = await supabaseClient.rpc("place_farm_fresh_order", {
            p_order_type: orderType,
            p_payment_method: paymentMethod,
            p_payment_reference: paymentReference,
            p_reservation_date: selectedDate,
            p_delivery_address: getDeliveryAddress(orderType),
            p_items: selectedCrops.map(item => ({
                product_id: item.cropId,
                quantity: item.quantity
            }))
        }));
    } catch (requestError) {
        return alert(`❌ Order was not placed: ${requestError.message}`);
    }
    if (error) return alert(`❌ Order was not placed: ${error.message}`);

    try {
        await loadAllData();
    } catch (loadError) {
        console.error("Order succeeded but refreshed order data failed:", loadError);
        alert(`✅ Order ${transactionId} was placed. Refresh the page to view the saved receipt.`);
        return;
    }

    const order = orders.find(item => item.id === transactionId);
    if (!order) return alert(`✅ Order ${transactionId} was placed, but its receipt could not be loaded. Open My Orders to view it.`);
    const totals = { quantity: order.totalQuantity, amount: order.totalAmount };
    const createdAt = order.createdAt;
    const paymentStatus = order.paymentStatus;
    const itemLines = order.items.map(item => `
        • ${escapeHTML(item.cropName)}:
        ${item.quantity}kg × ${formatCurrency(item.pricePerKg)}
        = ${formatCurrency(item.subtotal)}
    `).join("<br>");

    $("receipt-content").innerHTML = `
        <p><strong>Transaction ID:</strong> ${escapeHTML(transactionId)}</p>
        <p><strong>Receipt date:</strong> ${escapeHTML(new Date(createdAt).toLocaleString("en-PH"))}</p>
        <p><strong>Customer:</strong> ${escapeHTML(order.customer.fullName)}</p>
        <p><strong>Email:</strong> ${escapeHTML(order.customer.email)}</p>
        <p><strong>Phone:</strong> ${escapeHTML(order.customer.phone || "N/A")}</p>
        <p><strong>Address:</strong> ${escapeHTML(order.customer.address || "N/A")}</p>
        <hr>

        <p><strong>Order Type:</strong> ${escapeHTML(
            CONFIG.orderTypes[orderType].label
        )}</p>

        <p><strong>Items:</strong></p>
        ${itemLines}

        <hr>

        <p><strong>Total:</strong>
            ${totals.quantity} kg —
            ${formatCurrency(totals.amount)}
        </p>

        <p><strong>Payment method:</strong> ${escapeHTML(getPaymentMethodLabel(order.paymentMethod))}</p>
        <p><strong>Payment status:</strong> ${escapeHTML(paymentStatus)}</p>
        ${order.paymentReference ? `<p><strong>Payment reference:</strong> ${escapeHTML(order.paymentReference)}</p>` : ""}

        <p><strong>Reservation Date:</strong>
            ${escapeHTML(order.reservationDate)}
        </p>

        <p><strong>Preparation Time:</strong>
            ${escapeHTML(CONFIG.order.preparationTime)}
        </p>

        <hr>
        <p class="success">✅ Order recorded — ${escapeHTML(paymentStatus)}</p>
    `;

    hide("summary-section");
    show("receipt-section");

    alert(`✅ Order recorded. ${paymentStatus === "Due at cashier" ? "Please pay at the cashier." : "Payment is pending store verification."} Stock updated for everyone.`);
}

function backToMenu() {
    selectedCrops = [];
    hideSections(["receipt-section", "summary-section", "order-section"]);
    showBrowse();
}

/* =========================================================
   ADMIN PANEL
   ========================================================= */
function showAdminPanel() {
    hideSections([
        "browse-section",
        "order-section",
        "summary-section",
        "receipt-section",
        "customer-orders-section",
        "password-section"
    ]);

    show("admin-panel");
    updateAdminViewToggle();
    renderAdminTable();
    renderAdminCropImages();
    renderAdminPaymentQrs();
    renderAdminDates();
    renderAdminOrders();
}

function showCustomerView() {
    if (!currentUser || !isAdmin) return;

    hide("admin-panel");
    showBrowse();
    updateAdminViewToggle();
}

function updateAdminViewToggle() {
    const toggle = $("admin-view-toggle");
    if (!toggle) return;

    toggle.classList.toggle("hidden", !isAdmin);
    toggle.textContent = $("admin-panel").classList.contains("hidden")
        ? "Admin View"
        : "Customer View";
}

function toggleAdminCustomerView() {
    if (!currentUser || !isAdmin) return;

    if ($("admin-panel").classList.contains("hidden")) {
        showAdminPanel();
    } else {
        showCustomerView();
    }
}

function resizeImageForStorage(file, width, height, cropToFill, outputType, quality = .82) {
    return new Promise((resolve, reject) => {
        if (!file || !file.type.startsWith("image/")) {
            reject(new Error("Choose a valid image file."));
            return;
        }

        if (file.size > 12 * 1024 * 1024) {
            reject(new Error("Choose an image smaller than 12 MB."));
            return;
        }

        const reader = new FileReader();
        reader.onerror = () => reject(new Error("The image file could not be read."));
        reader.onload = () => {
            const image = new Image();
            image.onerror = () => reject(new Error("The selected file is not a readable image."));
            image.onload = () => {
                const canvas = document.createElement("canvas");
                const scale = cropToFill
                    ? Math.max(width / image.naturalWidth, height / image.naturalHeight)
                    : Math.min(1, width / image.naturalWidth, height / image.naturalHeight);
                const drawWidth = image.naturalWidth * scale;
                const drawHeight = image.naturalHeight * scale;

                canvas.width = cropToFill ? width : Math.max(1, Math.round(drawWidth));
                canvas.height = cropToFill ? height : Math.max(1, Math.round(drawHeight));

                const offsetX = cropToFill ? (width - drawWidth) / 2 : 0;
                const offsetY = cropToFill ? (height - drawHeight) / 2 : 0;
                const context = canvas.getContext("2d");
                context.drawImage(image, offsetX, offsetY, drawWidth, drawHeight);
                resolve(canvas.toDataURL(outputType, quality));
            };
            image.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}

function renderAdminCropImages() {
    const container = $("admin-crop-images");
    if (!container) return;

    container.innerHTML = crops.map((crop, index) => `
        <div class="admin-crop-image-item">
            ${crop.image
                ? `<img src="${escapeHTML(crop.image)}" alt="${escapeHTML(crop.name)} photo preview">`
                : '<div class="admin-photo-placeholder">No photo</div>'}
            <label>
                ${escapeHTML(crop.name)}
                <input type="file" accept="image/*" data-index="${index}" onchange="handleCropImageUpload(this)">
            </label>
        </div>
    `).join("");
}

async function handleCropImageUpload(input) {
    const index = Number(input.dataset.index);
    const crop = crops[index];
    const file = input.files?.[0];
    if (!crop || !file) return;

    try {
        const image = await resizeImageForStorage(file, 480, 320, true, "image/jpeg", .78);
        const { data, error } = await supabaseClient
            .from("products")
            .update({ image, updated_at: new Date().toISOString() })
            .eq("id", crop.id)
            .select("id")
            .single();
        if (error) throw error;
        if (!data) throw new Error("The product no longer exists.");
        crop.image = image;
        renderAdminCropImages();
        renderCrops();
    } catch (error) {
        alert(`⚠️ ${error.message}`);
    } finally {
        input.value = "";
    }
}

function renderAdminTable() {
    $("admin-crops-table").innerHTML = crops.map((crop, index) => {
        const visible = crop.available > CONFIG.order.minimumStock;

        return `
            <tr>
                <td><strong>${escapeHTML(crop.name)}</strong></td>
                <td>${escapeHTML(crop.type)}</td>

                <td>
                    <input
                        type="number"
                        step="0.01"
                        min="0"
                        value="${crop.pricePerKg}"
                        data-index="${index}"
                        class="adm-price input-sm"
                    >
                </td>

                <td>
                    <input
                        type="number"
                        step="1"
                        min="0"
                        value="${crop.available}"
                        data-index="${index}"
                        class="adm-stock input-sm"
                    >
                </td>

                <td>
                    ${
                        visible
                            ? '<span class="status-ok">✅ Visible</span>'
                            : '<span class="status-low">❌ Hidden</span>'
                    }
                </td>
                <td>
                    <button type="button" class="danger sm" onclick="removeCrop('${escapeHTML(crop.id)}')">Remove</button>
                </td>
            </tr>
        `;
    }).join("");
}

async function saveProducts(items) {
    if (!isAdmin) throw new Error("Administrator access required.");
    const { error } = await supabaseClient.from("products").upsert(items.map(crop => ({
        id: crop.id,
        name: crop.name,
        type: crop.type,
        stock_per_unit: crop.stockPerUnit,
        stock_kg: crop.available,
        price_per_kg: crop.pricePerKg,
        image: crop.image || "",
        updated_at: new Date().toISOString()
    })));
    if (error) throw error;
}

async function updateInventory(updates) {
    if (!isAdmin) throw new Error("Administrator access required.");
    if (!updates.length) return;
    const { error } = await supabaseClient.rpc("update_farm_fresh_inventory", {
        p_updates: updates
    });
    if (error) throw error;
}

async function addCrop(event) {
    event.preventDefault();
    if (!isAdmin) return alert("Only an administrator can add items.");

    const name = $("new-crop-name").value.trim();
    const type = $("new-crop-type").value.trim();
    const pricePerKg = Number($("new-crop-price").value);
    const available = Math.floor(Number($("new-crop-stock").value));

    if (!name || !type || !Number.isFinite(pricePerKg) || pricePerKg < 0 || !Number.isFinite(available) || available < 0) {
        return alert("Enter a valid item name, category, price, and stock quantity.");
    }

    const baseId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
    let id = baseId;
    let suffix = 2;
    while (crops.some(crop => crop.id === id)) {
        id = `${baseId}-${suffix}`;
        suffix += 1;
    }

    const crop = {
        id,
        name,
        type,
        stockPerUnit: available,
        available,
        pricePerKg,
        image: ""
    };
    try {
        await saveProducts([crop]);
        crops.push(crop);
    } catch (error) {
        return alert(`⚠️ Could not add item: ${error.message}`);
    }
    $("add-crop-form").reset();
    $("new-crop-type").value = "Vegetable";
    renderAdminTable();
    renderAdminCropImages();
    renderCrops();
}

async function removeCrop(cropId) {
    if (!isAdmin) return alert("Only an administrator can remove items.");

    const crop = crops.find(item => item.id === cropId);
    if (!crop) return;

    if (!confirm(`Remove ${crop.name} from the current inventory? Existing orders will keep their item details.`)) {
        return;
    }

    let error;
    try {
        ({ error } = await supabaseClient.from("products").delete().eq("id", cropId));
    } catch (requestError) {
        return alert(`⚠️ Could not remove item: ${requestError.message}`);
    }
    if (error) return alert(`⚠️ Could not remove item: ${error.message}`);
    crops = crops.filter(item => item.id !== cropId);
    renderAdminTable();
    renderAdminCropImages();
    renderCrops();
}

async function saveAdminChanges() {
    const priceInputs = Array.from(document.querySelectorAll(".adm-price"));
    const stockInputs = Array.from(document.querySelectorAll(".adm-stock"));
    if (
        priceInputs.length !== crops.length ||
        stockInputs.length !== crops.length ||
        priceInputs.some(input => input.value.trim() === "" || !Number.isFinite(Number(input.value)) || Number(input.value) < 0) ||
        stockInputs.some(input => input.value.trim() === "" || !Number.isInteger(Number(input.value)) || Number(input.value) < 0)
    ) {
        return alert("Enter valid non-negative prices and whole-number stock quantities.");
    }

    const changes = new Map();
    priceInputs.forEach(input => {
        const index = Number(input.dataset.index);
        const price = Number(input.value);
        if (price !== crops[index].pricePerKg) {
            changes.set(crops[index].id, { product_id: crops[index].id, price_per_kg: price });
        }
    });

    stockInputs.forEach(input => {
        const index = Number(input.dataset.index);
        const stock = Number(input.value);
        if (stock !== crops[index].available) {
            const existing = changes.get(crops[index].id) || { product_id: crops[index].id };
            existing.stock_kg = stock;
            changes.set(crops[index].id, existing);
        }
    });

    try {
        await updateInventory([...changes.values()]);
        await loadAllData();
    } catch (error) {
        return alert(`⚠️ Could not save inventory: ${error.message}`);
    }
    renderAdminTable();
    renderCrops();

    const message = $("admin-save-msg");
    message.style.display = "block";

    setTimeout(() => {
        message.style.display = "none";
    }, 3000);
}

async function resetStock() {
    if (!confirm("⚠️ Reset all stock quantities to defaults? Prices will be kept.")) {
        return;
    }

    const updates = crops.flatMap(crop => {
        const defaultCrop = DEFAULT_CROPS.find(item => item.id === crop.id);
        return defaultCrop && crop.available !== defaultCrop.available
            ? [{ product_id: crop.id, stock_kg: defaultCrop.available }]
            : [];
    });

    try {
        await updateInventory(updates);
        await loadAllData();
    } catch (error) {
        return alert(`⚠️ Could not reset stock: ${error.message}`);
    }
    renderAdminTable();
    renderCrops();

    alert("✅ Stock reset successfully.");
}

/* =========================================================
   ADMIN — CUSTOMER ORDERS
   ========================================================= */
function renderAdminOrders() {
    const container = $("admin-orders");
    if (!container) return;

    if (!orders.length) {
        container.innerHTML = '<p class="empty-message">No customer orders yet.</p>';
        return;
    }

    container.innerHTML = orders.map(order => `
        <div class="order-admin-card">
            <div class="order-admin-head">
                <strong>${escapeHTML(order.id)}</strong>
                <select onchange="updateOrderStatus('${escapeHTML(order.id)}', this.value)">
                    ${["Pending","Preparing","Ready","Delivered","Completed","Cancelled"].map(status => `
                        <option value="${status}" ${order.status === status ? "selected" : ""}>${status}</option>
                    `).join("")}
                </select>
            </div>
            <p><strong>Customer:</strong> ${escapeHTML(order.customer.fullName)}</p>
            <p><strong>Email:</strong> ${escapeHTML(order.customer.email)}</p>
            ${order.customer.phone ? `<p><strong>Phone:</strong> ${escapeHTML(order.customer.phone)}</p>` : ""}
            <p><strong>Order Type:</strong> ${escapeHTML(CONFIG.orderTypes[order.orderType]?.label || order.orderType)}</p>
            <p><strong>Payment Method:</strong> ${escapeHTML(getPaymentMethodLabel(order.paymentMethod))}</p>
            <p><strong>Payment Reference:</strong> ${escapeHTML(order.paymentReference || "Not provided")}</p>
            <label>Payment Status
                <select onchange="updatePaymentStatus('${escapeHTML(order.id)}', this.value)">
                    ${["Awaiting verification", "Due at cashier", "Payment submitted", "Paid", "Refunded"].map(status => `
                        <option value="${status}" ${(order.paymentStatus || "Awaiting verification") === status ? "selected" : ""}>${status}</option>
                    `).join("")}
                </select>
            </label>
            <p><strong>Date:</strong> ${escapeHTML(order.reservationDate)}</p>
            <p><strong>Address:</strong> ${escapeHTML(order.customer.address || "N/A")}</p>
            <div class="order-admin-items">
                ${order.items.map(item => `
                    <div>${escapeHTML(item.cropName)} — ${item.quantity}kg × ${formatCurrency(item.pricePerKg)} = ${formatCurrency(item.subtotal)}</div>
                `).join("")}
            </div>
            <p><strong>Total:</strong> ${order.totalQuantity}kg · ${formatCurrency(order.totalAmount)}</p>

            ${
                order.deliveryReceipt
                    ? `
                        <div class="delivery-receipt">
                            <h4>🧾 Delivery Receipt Issued</h4>
                            <p><strong>Receipt ID:</strong> ${escapeHTML(order.deliveryReceipt.receiptId)}</p>
                            <p><strong>Issued by:</strong> ${escapeHTML(order.deliveryReceipt.preparedBy)}</p>
                            <p><strong>Issued at:</strong> ${escapeHTML(new Date(order.deliveryReceipt.issuedAt).toLocaleString("en-PH"))}</p>
                            ${
                                order.customerReceivedAt
                                    ? `<span class="received-badge">✅ Customer received the item</span>`
                                    : `<span class="status-pill">⏳ Waiting for customer confirmation</span>`
                            }
                        </div>
                    `
                    : ""
            }
        </div>
    `).join("");
}

async function updatePaymentStatus(orderId, paymentStatus) {
    if (!isAdmin) {
        return alert("❌ Only an administrator can update payment status.");
    }

    const allowedStatuses = ["Awaiting verification", "Due at cashier", "Payment submitted", "Paid", "Refunded"];
    if (!orders.some(item => item.id === orderId) || !allowedStatuses.includes(paymentStatus)) return;
    let error;
    try {
        ({ error } = await supabaseClient.rpc("set_farm_fresh_payment_status", {
            p_order_id: orderId,
            p_status: paymentStatus
        }));
    } catch (requestError) {
        await refreshShopData();
        return alert(`⚠️ Could not update payment status: ${requestError.message}`);
    }
    if (error) return alert(`⚠️ Could not update payment status: ${error.message}`);
    await refreshShopData();
}

async function updateOrderStatus(orderId, status) {
    if (!isAdmin) {
        return alert("❌ Only an administrator can update order status.");
    }

    if (!orders.some(item => item.id === orderId)) return;
    let error;
    try {
        ({ error } = await supabaseClient.rpc("set_farm_fresh_order_status", {
            p_order_id: orderId,
            p_status: status
        }));
    } catch (requestError) {
        await refreshShopData();
        return alert(`⚠️ Could not update order status: ${requestError.message}`);
    }
    if (error) return alert(`⚠️ Could not update order status: ${error.message}`);
    await refreshShopData();
    if (status === "Delivered") {
        alert("✅ Item marked as DELIVERED. The delivery receipt is now available to the customer.");
    }
}

/* =========================================================
   ADMIN — RESERVATION DATES
   ========================================================= */
function renderAdminDates() {
    $("admin-dates").innerHTML = reservationDates.map((date, index) => `
        <div class="date-row">
            <input
                type="date"
                value="${escapeHTML(date)}"
                data-index="${index}"
                class="adm-date"
            >

            <button
                type="button"
                class="danger sm"
                onclick="removeDateRow(${index})"
                aria-label="Remove date"
            >
                ✕
            </button>
        </div>
    `).join("");
}

function addDateRow() {
    if (
        reservationDates.length >=
        CONFIG.order.maximumReservationDates
    ) {
        return alert(
            `⚠️ Maximum ${CONFIG.order.maximumReservationDates} reservation dates allowed.`
        );
    }

    const existing = new Set(reservationDates);
    let newDate = formatDate(7);

    while (existing.has(newDate)) {
        newDate = formatDate(
            Number(
                (new Date(newDate) - new Date()) /
                (1000 * 60 * 60 * 24)
            ) + 1
        );
    }

    reservationDates.push(newDate);
    normalizeReservationDates();
    renderAdminDates();
}

function removeDateRow(index) {
    if (reservationDates.length <= CONFIG.order.minimumReservationDates) {
        return alert(
            `⚠️ Minimum ${CONFIG.order.minimumReservationDates} dates required!`
        );
    }

    reservationDates.splice(index, 1);
    renderAdminDates();
}

async function saveDates() {
    const dates = Array.from(document.querySelectorAll(".adm-date"))
        .map(input => input.value)
        .filter(Boolean);

    const uniqueDates = [...new Set(dates)].sort();

    if (uniqueDates.length < CONFIG.order.minimumReservationDates) {
        return alert(
            `⚠️ Set at least ${CONFIG.order.minimumReservationDates} different dates.`
        );
    }

    if (uniqueDates.length > CONFIG.order.maximumReservationDates) {
        return alert(
            `⚠️ You can set a maximum of ${CONFIG.order.maximumReservationDates} dates.`
        );
    }

    let error;
    try {
        ({ error } = await supabaseClient.rpc("replace_farm_fresh_reservation_dates", {
            p_dates: uniqueDates
        }));
    } catch (requestError) {
        return alert(`⚠️ Could not save reservation dates: ${requestError.message}`);
    }
    if (error) return alert(`⚠️ Could not save reservation dates: ${error.message}`);
    reservationDates = uniqueDates;
    renderAdminDates();
    renderReservationDates();

    alert("✅ Reservation dates saved!");
}

/* =========================================================
   CUSTOMER — ORDERS & DELIVERY RECEIPTS
   ========================================================= */
function showCustomerOrders() {
    if (!currentUser || isAdmin) return;

    hideSections([
        "browse-section",
        "order-section",
        "summary-section",
        "receipt-section",
        "admin-panel"
    ]);

    show("customer-orders-section");
    renderCustomerOrders();
}

function renderCustomerOrders() {
    const container = $("customer-orders");
    if (!container || !currentUser) return;

    const myOrders = orders.filter(order =>
        order.customer &&
        order.customer.email &&
        order.customer.email.toLowerCase() === currentUser.email.toLowerCase()
    );

    if (!myOrders.length) {
        container.innerHTML = '<p class="empty-message">You have no orders yet.</p>';
        return;
    }

    container.innerHTML = myOrders.map(order => {
        const receipt = order.deliveryReceipt;

        return `
            <div class="customer-order-card">
                <div class="customer-order-head">
                    <strong>${escapeHTML(order.id)}</strong>
                    <span class="status-pill">${escapeHTML(order.status)}</span>
                </div>

                <p><strong>Order Type:</strong> ${escapeHTML(
                    CONFIG.orderTypes[order.orderType]?.label || order.orderType
                )}</p>
                <p><strong>Date:</strong> ${escapeHTML(order.reservationDate)}</p>
                <p><strong>Payment Method:</strong> ${escapeHTML(getPaymentMethodLabel(order.paymentMethod))}</p>
                <p><strong>Payment Status:</strong> ${escapeHTML(order.paymentStatus || "Not recorded")}</p>
                ${order.paymentReference ? `<p><strong>Payment Reference:</strong> ${escapeHTML(order.paymentReference)}</p>` : ""}
                <p><strong>Total:</strong> ${order.totalQuantity}kg · ${formatCurrency(order.totalAmount)}</p>

                <div class="order-admin-items">
                    ${order.items.map(item => `
                        <div>${escapeHTML(item.cropName)} — ${item.quantity}kg × ${formatCurrency(item.pricePerKg)} = ${formatCurrency(item.subtotal)}</div>
                    `).join("")}
                </div>

                ${
                    receipt
                        ? `
                            <div class="delivery-receipt">
                                <h4>🧾 Item Delivered — Delivery Receipt</h4>
                                <p><strong>Receipt ID:</strong> ${escapeHTML(receipt.receiptId)}</p>
                                <p><strong>Transaction ID:</strong> ${escapeHTML(receipt.transactionId)}</p>
                                <p><strong>Prepared by:</strong> ${escapeHTML(receipt.preparedBy)}</p>
                                <p><strong>Admin email:</strong> ${escapeHTML(receipt.adminEmail)}</p>
                                <p><strong>Issued:</strong> ${escapeHTML(new Date(receipt.issuedAt).toLocaleString("en-PH"))}</p>
                                <p><strong>Payment:</strong> ${escapeHTML(getPaymentMethodLabel(receipt.paymentMethod))} — ${escapeHTML(receipt.paymentStatus || "Not recorded")}</p>
                                ${receipt.paymentReference ? `<p><strong>Payment Reference:</strong> ${escapeHTML(receipt.paymentReference)}</p>` : ""}
                                <hr>
                                <p><strong>Items:</strong></p>
                                ${receipt.items.map(item => `
                                    • ${escapeHTML(item.cropName)}:
                                    ${item.quantity}kg × ${formatCurrency(item.pricePerKg)}
                                    = ${formatCurrency(item.subtotal)}
                                `).join("<br>")}
                                <hr>
                                <p><strong>Total:</strong> ${receipt.totalQuantity}kg — ${formatCurrency(receipt.totalAmount)}</p>

                                <button onclick="markItemReceived('${escapeHTML(order.id)}')">
                                    ✅ ITEM RECEIVED
                                </button>
                            </div>
                        `
                        : order.customerReceivedAt
                            ? `<span class="received-badge">✅ Item received and delivery receipt removed.</span>`
                            : ""
                }
            </div>
        `;
    }).join("");
}

async function markItemReceived(orderId) {
    if (!currentUser || isAdmin) return;

    const order = orders.find(item =>
        item.id === orderId &&
        item.customer &&
        item.customer.email &&
        item.customer.email.toLowerCase() === currentUser.email.toLowerCase()
    );

    if (!order) {
        return alert("❌ Order not found.");
    }

    if (order.status !== "Delivered" || !order.deliveryReceipt) {
        return alert("⚠️ This order does not currently have a delivery receipt.");
    }

    if (!confirm("Confirm that you received this item? The delivery receipt will be removed.")) {
        return;
    }

    let error;
    try {
        ({ error } = await supabaseClient.rpc("confirm_farm_fresh_order_received", {
            p_order_id: orderId
        }));
    } catch (requestError) {
        return alert(`⚠️ Could not confirm delivery: ${requestError.message}`);
    }
    if (error) return alert(`⚠️ Could not confirm delivery: ${error.message}`);
    await refreshShopData();

    alert("✅ Item received! The delivery receipt has been removed.");
}

/* =========================================================
   UI INITIALIZATION
   ========================================================= */
let particleFrame = 0;
let particleNodes = [];
let particleContext = null;
let particleWidth = 0;
let particleHeight = 0;
const particlePointer = { x: -1000, y: -1000 };
const reducedMotionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");

function resizeParticleField() {
    if (!document.body.classList.contains("auth-scene")) return;

    const canvas = $("particle-field");
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    particleWidth = window.innerWidth;
    particleHeight = window.innerHeight;
    canvas.width = Math.floor(particleWidth * pixelRatio);
    canvas.height = Math.floor(particleHeight * pixelRatio);
    particleContext = canvas.getContext("2d");
    particleContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

    const count = Math.max(28, Math.min(76, Math.floor(particleWidth * particleHeight / 18000)));
    particleNodes = Array.from({ length: count }, () => ({
        x: Math.random() * particleWidth,
        y: Math.random() * particleHeight,
        vx: (Math.random() - .5) * .34,
        vy: (Math.random() - .5) * .34,
        radius: 1 + Math.random() * 1.8,
        hue: Math.random() > .5 ? 146 : 78
    }));
}

function drawParticleField() {
    if (!document.body.classList.contains("auth-scene") || !particleContext) {
        particleFrame = 0;
        return;
    }

    const context = particleContext;
    context.clearRect(0, 0, particleWidth, particleHeight);
    context.globalCompositeOperation = "lighter";

    particleNodes.forEach((node, index) => {
        node.x += node.vx;
        node.y += node.vy;

        if (node.x < -8) node.x = particleWidth + 8;
        if (node.x > particleWidth + 8) node.x = -8;
        if (node.y < -8) node.y = particleHeight + 8;
        if (node.y > particleHeight + 8) node.y = -8;

        for (let nextIndex = index + 1; nextIndex < particleNodes.length; nextIndex += 1) {
            const next = particleNodes[nextIndex];
            const distance = Math.hypot(node.x - next.x, node.y - next.y);

            if (distance < 128) {
                context.beginPath();
                context.strokeStyle = `rgba(112, 255, 195, ${(1 - distance / 128) * .2})`;
                context.lineWidth = .7;
                context.moveTo(node.x, node.y);
                context.lineTo(next.x, next.y);
                context.stroke();
            }
        }

        const pointerDistance = Math.hypot(node.x - particlePointer.x, node.y - particlePointer.y);
        if (pointerDistance < 150) {
            context.beginPath();
            context.strokeStyle = `rgba(204, 255, 105, ${(1 - pointerDistance / 150) * .34})`;
            context.lineWidth = .8;
            context.moveTo(node.x, node.y);
            context.lineTo(particlePointer.x, particlePointer.y);
            context.stroke();
        }

        context.beginPath();
        context.fillStyle = `hsla(${node.hue}, 100%, 72%, .8)`;
        context.shadowBlur = 15;
        context.shadowColor = `hsla(${node.hue}, 100%, 66%, .9)`;
        context.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        context.fill();
    });

    context.shadowBlur = 0;
    context.globalCompositeOperation = "source-over";
    particleFrame = window.requestAnimationFrame(drawParticleField);
}

function setAuthAtmosphere(enabled) {
    document.body.classList.toggle("auth-scene", enabled);

    if (!enabled) {
        if (particleFrame) window.cancelAnimationFrame(particleFrame);
        particleFrame = 0;
        particleContext?.clearRect(0, 0, particleWidth, particleHeight);
        $("auth-section").style.setProperty("--tilt-x", "0deg");
        $("auth-section").style.setProperty("--tilt-y", "0deg");
        return;
    }

    if (reducedMotionPreference.matches) return;
    resizeParticleField();
    if (!particleFrame) particleFrame = window.requestAnimationFrame(drawParticleField);
}

function initializeAuthInteractions() {
    const authCard = $("auth-section");

    authCard.addEventListener("pointermove", event => {
        if (reducedMotionPreference.matches || event.pointerType === "touch") return;

        const bounds = authCard.getBoundingClientRect();
        const horizontal = (event.clientX - bounds.left) / bounds.width;
        const vertical = (event.clientY - bounds.top) / bounds.height;
        authCard.style.setProperty("--pointer-x", `${horizontal * 100}%`);
        authCard.style.setProperty("--pointer-y", `${vertical * 100}%`);
        authCard.style.setProperty("--tilt-x", `${(0.5 - vertical) * 5}deg`);
        authCard.style.setProperty("--tilt-y", `${(horizontal - 0.5) * 6}deg`);
    });

    authCard.addEventListener("pointerleave", () => {
        authCard.style.setProperty("--pointer-x", "50%");
        authCard.style.setProperty("--pointer-y", "0%");
        authCard.style.setProperty("--tilt-x", "0deg");
        authCard.style.setProperty("--tilt-y", "0deg");
    });

    window.addEventListener("pointermove", event => {
        particlePointer.x = event.clientX;
        particlePointer.y = event.clientY;
    }, { passive: true });

    window.addEventListener("resize", resizeParticleField, { passive: true });
}

async function initializeApp() {
    try {
        localStorage.removeItem("ff_users");
    } catch (error) {
        console.error("Could not remove legacy browser-stored credentials:", error);
    }

    renderOrderOptions();
    renderPaymentOptions();
    initializeAuthInteractions();
    setAuthAtmosphere(true);

    $("prep-time-label").textContent =
        `${CONFIG.order.preparationTime.toUpperCase()} PREPARATION TIME`;

    $("stock-rule-label").textContent =
        `${CONFIG.order.minimumStock}kg`;

    $("browse-stock-limit").textContent =
        CONFIG.order.minimumStock;

    $("admin-stock-limit").textContent =
        CONFIG.order.minimumStock;

    $("min-date-label").textContent =
        CONFIG.order.minimumReservationDates;

    show("login-form");
    const { data, error } = await supabaseClient.auth.getSession();
    if (error) {
        console.error("Could not restore Supabase session:", error);
        alert(`⚠️ Could not restore login session: ${error.message}`);
        return;
    }
    if (data.session) {
        await completeSupabaseLogin(data.session.user);
        if (authLinkType === "invite" || authLinkType === "recovery") showPasswordSection();
    }
}

initializeApp().catch(error => {
    console.error("Farm Fresh initialization failed:", error);
    alert(`⚠️ Farm Fresh could not start: ${error.message}`);
});
