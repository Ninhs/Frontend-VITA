"use strict";


// ============================================================================
// CẤU HÌNH BACKEND — frontend chạy trên GitHub Pages, backend chạy trên Render,
// nên MỌI lệnh gọi API phải trỏ tuyệt đối sang domain Render, không dùng
// đường dẫn tương đối "/api/..." (đường dẫn tương đối sẽ gọi nhầm vào chính
// domain GitHub Pages, nơi không chạy backend).
// SỬA DÒNG NÀY thành đúng URL Render của bạn, KHÔNG có dấu "/" ở cuối.
const API_BASE = "https://backend-vita.onrender.com";
// ============================================================================


const state = {
  contractId: "CON-004",
  latestPayload: null,
  chartRows: [],
  riskAdjustment: 0,
  anomalyTransactions: [],
  anomalyMetricLoaded: false,
};


const _warnedMissingIds = new Set();
function _safeStub(id) {
  // Trả về 1 object "vô hại" khi không tìm thấy #id trong HTML, để
  // byId("x").textContent = ... / .style.display = ... / .addEventListener(...)
  // không bao giờ ném lỗi làm dừng render giữa chừng (lỗi 1 chỗ từng khiến
  // nhiều phần khác của dashboard "đứng hình", không cập nhật theo dữ liệu mới).
  if (!_warnedMissingIds.has(id)) {
    _warnedMissingIds.add(id);
    console.warn(`[UI] Không tìm thấy phần tử #${id} trong HTML — bỏ qua an toàn, không crash trang.`);
  }
  const handler = {
    get(_target, prop) {
      if (prop === "style" || prop === "classList" || prop === "dataset") return _safeStub(`${id}.${String(prop)}`);
      if (prop === "addEventListener" || prop === "focus" || prop === "select") return () => {};
      return undefined;
    },
    set() {
      return true;
    },
  };
  return new Proxy({}, handler);
}
const byId = (id) => document.getElementById(id) || _safeStub(id);
const firstDefined = (...values) => values.find((value) => value !== undefined && value !== null && value !== "");


function parseJsonMaybe(value) {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}


function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}


function normalizeRatio(value) {
  const number = numberValue(value, NaN);
  if (!Number.isFinite(number)) return null;
  return Math.abs(number) <= 1 ? number : number / 100;
}


function booleanValue(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y"].includes(normalized)) return true;
    if (["false", "0", "no", "n", ""].includes(normalized)) return false;
  }
  if (typeof value === "number") return value !== 0;
  return value == null ? fallback : Boolean(value);
}


function formatPercent(value, digits = 0) {
  const ratio = normalizeRatio(value);
  if (ratio === null) return "—";
  return `${(ratio * 100).toFixed(digits)}%`;
}


function formatMoney(value) {
  const amount = numberValue(value, NaN);
  if (!Number.isFinite(amount)) return "—";
  const abs = Math.abs(amount);
  if (abs >= 1_000_000_000) return `${(amount / 1_000_000_000).toFixed(abs % 1_000_000_000 === 0 ? 0 : 1)} tỷ`;
  if (abs >= 1_000_000) return `${(amount / 1_000_000).toFixed(abs % 1_000_000 === 0 ? 0 : 1)} triệu`;
  return new Intl.NumberFormat("vi-VN").format(amount);
}


function formatFullMoney(value) {
  const amount = numberValue(value, NaN);
  return Number.isFinite(amount)
    ? `${new Intl.NumberFormat("vi-VN").format(amount)} VND`
    : "—";
}


function escapeText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}


async function requestJson(url, options = {}) {
  // Nối API_BASE nếu url là đường dẫn tương đối bắt đầu bằng "/"
  const fullUrl = API_BASE && url.startsWith("/") ? `${API_BASE}${url}` : url;
  let response;
  try {
    response = await fetch(fullUrl, {
      ...options,
      // Bắt buộc khi frontend/backend khác domain: nếu không có dòng này,
      // cookie đăng nhập (vita_session) sẽ KHÔNG được gửi kèm request, khiến
      // mọi API trả 401 dù đã đăng nhập thành công.
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
  } catch (networkError) {
    // fetch() ném lỗi "Failed to fetch" (không có response nào cả) khi bị
    // CORS chặn hoặc backend Render không phản hồi được. Đây gần như luôn
    // là do ALLOWED_ORIGINS trên Render chưa có domain GitHub Pages, hoặc
    // backend đang sleep/không chạy — KHÔNG phải do sai code frontend.
    throw new Error(
      `Không kết nối được tới backend (${fullUrl}). Kiểm tra: (1) Render có ` +
      `đang chạy không — mở ${API_BASE || "URL backend"}/health trên trình duyệt; ` +
      `(2) biến ALLOWED_ORIGINS trên Render đã có đúng domain GitHub Pages chưa.`
    );
  }


  const rawBody = await response.text();
  let body = {};
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    body = { detail: rawBody || `HTTP ${response.status}` };
  }


  if (response.status === 401) {
    // Trên GitHub Pages không có middleware server-side chặn truy cập
    // index.html khi chưa đăng nhập -> tự chuyển về login.html ở đây khi
    // backend báo phiên đăng nhập không hợp lệ/hết hạn. Tránh redirect nếu
    // đang đứng sẵn ở login.html (khỏi lặp trang vô ích).
    if (!window.location.pathname.endsWith("login.html")) {
      console.warn("401 từ backend — có thể do cookie chưa được gửi kèm (kiểm tra COOKIE_SAMESITE=none, COOKIE_SECURE=true trên Render).");
      window.location.replace("login.html");
    }
    throw new Error("Phiên đăng nhập không hợp lệ hoặc đã hết hạn.");
  }


  if (!response.ok) {
    const message = body.detail || body.message || `HTTP ${response.status}`;
    throw new Error(typeof message === "string" ? message : JSON.stringify(message));
  }


  return body;
}


function setLoading(isLoading) {
  byId("loadingOverlay").hidden = !isLoading;
  byId("analyzeButton").disabled = isLoading;
  if (isLoading) {
    byId("workflowStatus").className = "status-pill status-running";
    byId("workflowStatus").textContent = "Đang chạy";
    byId("agentState").textContent = "Đang xử lý";
  }
}


let toastTimer;
function showToast(message, isError = false) {
  const toast = byId("toast");
  toast.textContent = message;
  toast.className = `toast show${isError ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.className = "toast";
  }, 4200);
}


function setProgress(prefix, confidence) {
  const ratio = normalizeRatio(confidence);
  const percent = ratio === null ? 0 : Math.max(0, Math.min(100, ratio * 100));
  byId(`${prefix}Confidence`).textContent = ratio === null ? "—" : `${Math.round(percent)}%`;
  byId(`${prefix}Progress`).style.width = `${percent}%`;
}


function unionFlags(...groups) {
  const values = groups.flatMap((group) => Array.isArray(group) ? group : []);
  return [...new Set(values.filter(Boolean))];
}


function textList(...values) {
  return values.flatMap((value) => {
    const parsed = parseJsonMaybe(value);
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === "string" && parsed.trim()) return [parsed.trim()];
    return [];
  }).filter(Boolean);
}



function normalizeCashflowRows(value) {
  const parsed = parseJsonMaybe(value);
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? parseJsonMaybe(parsed.monthly_summary)
      : [];

  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const nested = parseJsonMaybe(row.monthly_summary);
    return Array.isArray(nested) ? nested : [row];
  });
}

function cashflowClosing(row) {
  return numberValue(firstDefined(
    row.projected_closing_cash,
    row.closing_cash,
    row.balance
  ), NaN);
}

function cashflowReserve(row) {
  return numberValue(firstDefined(
    row.cash_reserve_minimum,
    row.reserve_minimum,
    row.minimum_reserve
  ), NaN);
}

function normalizePayload(payload) {
  const outputs = payload.outputs
    || payload.data?.outputs
    || payload.dify_response?.data?.outputs
    || {};


  const decision = parseJsonMaybe(outputs.decision);
  const finance = parseJsonMaybe(outputs.finance_result);
  
  // Tự động map dữ liệu khách hàng vào hợp đồng để lấy Tỉnh, Loại, Điểm tin cậy
  const baseContract = payload.contract || payload.case_data?.contract || {};
  const customers = payload.case_data?.related_data?.customers || [];
  const baseCId = String(baseContract.customer_id || "").trim();
  const matchedCustomer = customers.find(c => String(c.customer_id || "").trim() === baseCId) || customers[0] || {};


  const contract = { ...matchedCustomer, ...baseContract };


  const financialSummary = finance.financial_summary || {};
  const cashflowSummary = finance.cashflow_summary || {};
  const summary = decision.summary || {};


  const chartRows = normalizeCashflowRows(firstDefined(
    cashflowSummary.monthly_summary,
    outputs.monthly_summary,
    payload.case_data?.related_data?.cashflow,
    payload.case_data?.related_data?.cashflow_forecasts,
    []
  ));


  const flags = unionFlags(
    outputs.financial_flags,
    decision.financial_flags,
    finance.financial_flags
  );


  const computedMargin = firstDefined(
    outputs.computed_margin,
    summary.computed_margin,
    financialSummary.computed_margin,
    contract.gross_margin
  );


  const targetMargin = firstDefined(
    outputs.target_margin,
    summary.target_margin,
    financialSummary.target_margin,
    contract.target_margin,
    0.28
  );


  const computedRatio = normalizeRatio(computedMargin);
  const targetRatio = normalizeRatio(targetMargin);
  const marginGap = firstDefined(
    outputs.margin_gap,
    summary.margin_gap,
    financialSummary.margin_gap,
    computedRatio !== null && targetRatio !== null
      ? computedRatio - targetRatio
      : null
  );


  const reserveMinimum = firstDefined(
    chartRows.map(cashflowReserve).find(Number.isFinite),
    contract.cash_reserve_minimum,
    contract.reserve_minimum
  );


  const workflowRunId = payload.dify_response?.workflow_run_id
    || payload.dify_response?.data?.id
    || payload.workflow_run_id
    || null;


  const relatedData = payload.case_data?.related_data || {};
  const missingFields = unionFlags(
    outputs.missing_fields,
    decision.missing_fields,
    decision.external_reasons,
    Array.isArray(relatedData.orders) && !relatedData.orders.length ? ["orders"] : [],
    Array.isArray(relatedData.cashflow) && !relatedData.cashflow.length ? ["cashflow"] : []
  );


  const contractValue = firstDefined(
    contract.contract_value,
    contract.value,
    contract.total_value
  );


  const derivedFundingNeed = chartRows.reduce((maximum, row) => {
    const reserve = cashflowReserve(row);
    const closing = cashflowClosing(row);
    if (!Number.isFinite(reserve) || !Number.isFinite(closing)) return maximum;
    return Math.max(maximum, reserve - closing, 0);
  }, 0);

  const fundingNeed = firstDefined(
    outputs.maximum_funding_need,
    summary.maximum_funding_need,
    finance.funding_need,
    cashflowSummary.maximum_funding_need,
    derivedFundingNeed
  );

  const derivedMonthsBelowReserve = chartRows
    .filter((row) => {
      const reserve = cashflowReserve(row);
      const closing = cashflowClosing(row);
      return Number.isFinite(reserve) && Number.isFinite(closing) && closing < reserve;
    })
    .map((row, index) => row.month || row.period || "T" + (index + 1));

  const reportedMonthsBelowReserve = firstDefined(
    outputs.months_below_reserve,
    summary.months_below_reserve,
    finance.months_below_reserve,
    cashflowSummary.months_below_reserve
  );
  const monthsBelowReserve = Array.isArray(reportedMonthsBelowReserve) && reportedMonthsBelowReserve.length
    ? reportedMonthsBelowReserve
    : derivedMonthsBelowReserve;

  const reportedRisk = String(firstDefined(
    finance.cashflow_risk_level,
    outputs.risk_level,
    decision.risk_level,
    "UNKNOWN"
  )).toUpperCase();
  const derivedRisk = derivedMonthsBelowReserve.length >= 2
    ? "HIGH"
    : derivedMonthsBelowReserve.length || (normalizeRatio(marginGap) ?? 0) < 0
      ? "MEDIUM"
      : "LOW";
  const riskLevel = reportedRisk === "UNKNOWN" || reportedRisk === ""
    ? derivedRisk
    : reportedRisk;
  const requestedAmount = firstDefined(outputs.requested_amount, decision.requested_amount, finance.requested_amount, contract.requested_amount, fundingNeed, 0);
  const approvalRequired = booleanValue(firstDefined(
    outputs.approval_required,
    decision.approval_required,
    contractValue != null ? numberValue(contractValue) > 300_000_000 : false
  ));

  const hasOrderTotals = [
    outputs.total_order_revenue,
    summary.total_order_revenue,
    financialSummary.total_order_revenue,
    outputs.total_estimated_cost,
    summary.total_estimated_cost,
    financialSummary.total_estimated_cost
  ].some((value) => Number.isFinite(numberValue(value, NaN)));
  const hasWorkflowResult = Boolean(workflowRunId)
    && String(firstDefined(payload.dify_response?.data?.status, outputs.status, "")).toLowerCase() !== "failed";
  const derivedConfidence = Math.min(1,
    0.30
    + (chartRows.length ? 0.35 : 0)
    + (hasOrderTotals ? 0.20 : 0)
    + (hasWorkflowResult ? 0.15 : 0)
  );
  const anomalyCountForRisk = Math.max(
    numberValue(firstDefined(outputs.anomaly_transaction_count, decision.anomaly_transaction_count, 0), 0),
    Array.isArray(state.anomalyTransactions) ? state.anomalyTransactions.length : 0
  );
  const derivedRiskScore = Math.min(100,
    Math.min(60, derivedMonthsBelowReserve.length * 12)
    + ((normalizeRatio(marginGap) ?? 0) < 0 ? 20 : 0)
    + Math.min(20, anomalyCountForRisk * 10)
  );


  return {
    payload,
    outputs,
    decision,
    finance,
    contract,
    chartRows: Array.isArray(chartRows) ? chartRows : [],
    flags,
    missingFields,
    computedMargin,
    targetMargin,
    marginGap,
    reserveMinimum,
    fundingNeed,
    monthsBelowReserve: Array.isArray(monthsBelowReserve) ? monthsBelowReserve : [],
    contractValue,
    workflowRunId,
    riskLevel,
    // outputs.risk_score / transaction_risk_score được Risk & Compliance Agent
    // tính 0-100 (không phải %). Trước đây field bị thất lạc trước End node
    // nên luôn về 0 — đã vá ở tầng Dify, ở đây chỉ cần đọc đúng key theo
    // đúng thứ tự ưu tiên.
    riskScore: firstDefined(
      outputs.risk_score,
      outputs.transaction_risk_score,
      decision.risk_score,
      decision.risk_summary?.risk_score,
      finance.risk_score,
      derivedRiskScore
    ),
    confidenceScore: firstDefined(
      outputs.decision_confidence,
      decision.confidence_score,
      outputs.confidence_score,
      finance.confidence_score,
      derivedConfidence
    ),
    requestedAmount,
    // outputs.protective_conditions và decision.protective_conditions
    // thường chứa CÙNG một câu (backend ghi trùng ở 2 chỗ) -> phải loại
    // trùng ở đây, nếu không câu điều kiện bảo vệ sẽ lặp lại 2 lần.
    protectiveConditions: [...new Set(textList(
      outputs.protective_conditions,
      outputs.protection_conditions,
      decision.protective_conditions,
      decision.conditions,
      finance.protective_conditions
    ))],
    approvalRequired,
    openInvoiceAmount: firstDefined(outputs.open_invoice_amount, summary.open_invoice_amount),
    totalRevenue: firstDefined(outputs.total_order_revenue, summary.total_order_revenue, financialSummary.total_order_revenue),
    totalCost: firstDefined(outputs.total_estimated_cost, summary.total_estimated_cost, financialSummary.total_estimated_cost),
    agentDecision: firstDefined(outputs.agent_decision, decision.agent_decision, "UNKNOWN"),
    status: firstDefined(outputs.status, decision.status, finance.status, payload.dify_response?.data?.status, "unknown"),
    message: firstDefined(outputs.message, decision.message, finance.message, ""),
    // Bài phân tích tiếng Việt do OpenAI viết (Data & Finance Agent) — ưu
    // tiên hiển thị cái này thay vì message chung chung.
    financeAnalysis: firstDefined(finance.finance_analysis, outputs.finance_analysis, ""),
    decisionReasons: textList(
      decision.reasons,
      [decision.reason_1, decision.reason_2, decision.reason_3].filter(Boolean)
    ).slice(0, 3),
    // Số giao dịch bất thường (RR-001) thực sự cần Founder xử lý.
    anomalyTransactionCount: numberValue(
      firstDefined(outputs.anomaly_transaction_count, decision.anomaly_transaction_count, 0),
      0
    ),
    // Chi tiết từng giao dịch bất thường: mã GD + risk_score + căn cứ.
    anomalyTransactions: (() => {
      const parsed = parseJsonMaybe(outputs.anomaly_transactions_json);
      if (Array.isArray(parsed) && parsed.length) return parsed;
      if (Array.isArray(decision.anomaly_transactions)) return decision.anomaly_transactions;
      return [];
    })(),
    // Diễn giải vì sao từng cờ được kích hoạt (thay cho việc chỉ đếm số cờ).
    flagInsights: (() => {
      const parsed = parseJsonMaybe(outputs.flag_insights_json);
      if (Array.isArray(parsed) && parsed.length) return parsed;
      if (Array.isArray(decision.flag_insights)) return decision.flag_insights;
      return [];
    })(),
    confidenceExplanation: firstDefined(outputs.confidence_explanation, decision.confidence_explanation, ""),
  };
}


function renderChecks(data) {
  // Mục này CHỈ trả lời 1 câu hỏi: hệ thống đọc được đủ dữ liệu cần thiết
  // cho hợp đồng này chưa (có/không có trong bảng dữ liệu), KHÔNG lẫn với
  // các cờ rủi ro/tài chính (đã có ở phần diễn giải văn xuôi của từng agent)
  // để tránh gây rối cho người đọc.
  const hasOrderData = numberValue(data.totalRevenue) > 0 || numberValue(data.totalCost) > 0;
  const checks = [
    {
      status: data.contract.contract_id ? "ok" : "error",
      text: data.contract.contract_id
        ? `Đã tìm thấy hợp đồng ${data.contract.contract_id} trong bảng contracts.`
        : `Không tìm thấy hợp đồng ${state.contractId} trong bảng contracts.`,
    },
    {
      status: hasOrderData ? "ok" : "warning",
      text: hasOrderData
        ? "Đã đọc được dữ liệu đơn hàng (orders) của hợp đồng."
        : "Không tìm thấy dữ liệu đơn hàng (orders) cho hợp đồng này.",
    },
    {
      status: data.openInvoiceAmount > 0 ? "ok" : "warning",
      text: data.openInvoiceAmount > 0
        ? `Hóa đơn của khách hàng ${firstDefined(data.contract.customer_name, data.contract.customer_id, "—")} (hợp đồng ${state.contractId}): còn ${formatFullMoney(data.openInvoiceAmount)} chưa thanh toán.`
        : `Khách hàng ${firstDefined(data.contract.customer_name, data.contract.customer_id, "—")} (hợp đồng ${state.contractId}): không có hóa đơn chưa thanh toán, hoặc chưa đọc được dữ liệu hóa đơn.`,
    },
    {
      status: data.chartRows.length ? "ok" : "warning",
      text: data.chartRows.length
        ? `Đã đọc được dữ liệu dự báo dòng tiền (cashflow) cho ${data.chartRows.length} tháng.`
        : "Không tìm thấy dữ liệu dự báo dòng tiền (cashflow) cho hợp đồng này.",
    },
    ...data.missingFields.map((field) => ({
      status: "error",
      text: `Thiếu trường dữ liệu bắt buộc: ${field}.`,
    })),
  ];


  byId("dataChecks").innerHTML = checks.map((item) => `
    <li><span class="dot dot-${item.status}"></span>${escapeText(item.text)}</li>
  `).join("");
}


function recommendationList(data) {
  const items = [];
  const marginGap = normalizeRatio(data.marginGap);


  if (marginGap !== null && marginGap < 0) {
    items.push("Rà soát pricing, chi phí và biên lợi nhuận trước khi ký.");
  }
  if (numberValue(data.fundingNeed) > 0) {
    items.push(`Chuẩn bị phương án vốn lưu động tối đa ${formatMoney(data.fundingNeed)}.`);
  }
  if (data.monthsBelowReserve.length) {
    items.push(`Bổ sung nguồn vốn trước các tháng ${data.monthsBelowReserve.join(", ")} để tiền cuối kỳ không thấp hơn ${formatMoney(data.reserveMinimum)}.`);
  }
  if (data.missingFields.length) {
    items.push(`Bổ sung dữ liệu: ${data.missingFields.join(", ")}.`);
  }
  if (data.approvalRequired) {
    items.push("Chuyển Founder phê duyệt theo số tiền đề nghị trong hồ sơ tín dụng.");
  }
  if (!items.length) items.push("Có thể tiếp tục quy trình phê duyệt thông thường.");
  return items;
}


function renderDashboard(payload) {
  const data = normalizePayload(payload);
  state.latestPayload = payload;
  state.chartRows = data.chartRows;
  state.contractId = data.contract.contract_id || state.contractId;


  byId("customerName").value = firstDefined(
    data.contract.customer_name,
    data.contract.customer,
    data.contract.customer_id,
    "Không có tên khách hàng"
  );
  byId("contractType").textContent = firstDefined(data.contract.type, data.contract.contract_type, data.contract.customer_type, "—");
  byId("contractCity").textContent = firstDefined(data.contract.city, data.contract.province, data.contract.location, "—");
  byId("paymentReliability").textContent = formatPercent(firstDefined(data.contract.payment_reliability, data.contract.reliability_score), 0);
  byId("strategicValue").textContent = firstDefined(data.contract.strategic_value, "—");
  byId("grossMargin").textContent = formatPercent(data.computedMargin, 0);
  byId("contractValue").textContent = formatMoney(data.contractValue);
  byId("fundingNeed").textContent = formatMoney(data.fundingNeed);
  byId("reserveMinimum").textContent = formatMoney(data.reserveMinimum);


  const status = String(data.status).toLowerCase();
  byId("workflowStatus").textContent = status === "partial" ? "Partial" : status === "succeeded" ? "Succeeded" : status;
  byId("workflowStatus").className = `status-pill ${status === "partial" ? "status-partial" : status === "succeeded" ? "status-success" : "status-idle"}`;
  byId("agentState").textContent = status === "partial" ? "Cần bổ sung dữ liệu" : "Đã hoàn thành";


  renderChecks(data);


  const marginGapRatio = normalizeRatio(data.marginGap);
  const fallbackFindings = [
    Number.isFinite(numberValue(data.totalRevenue, NaN)) || Number.isFinite(numberValue(data.totalCost, NaN))
      ? `Doanh thu ${formatMoney(data.totalRevenue)}, chi phí ${formatMoney(data.totalCost)}.`
      : "Chưa có dữ liệu orders để tính tổng doanh thu và chi phí.",
    `Biên lợi nhuận ${formatPercent(data.computedMargin)} so với mục tiêu ${formatPercent(data.targetMargin)}; chênh lệch ${marginGapRatio === null ? "—" : `${(marginGapRatio * 100).toFixed(1)} điểm %`}.`,
    data.chartRows.length
      ? `Dòng tiền thực tế theo ${data.chartRows.length} tháng: nhu cầu vốn tối đa ${formatMoney(data.fundingNeed)}, dự trữ tối thiểu ${formatMoney(data.reserveMinimum)}, ${data.monthsBelowReserve.length} tháng dưới ngưỡng.`
      : "Chưa có dữ liệu cashflow để đánh giá nhu cầu vốn và mức dự trữ."
  ];
  const findings = data.decisionReasons.length
    ? [...data.decisionReasons, ...fallbackFindings].slice(0, 3)
    : fallbackFindings;
  byId("keyFindings").innerHTML = findings.map((text) => `<li>${escapeText(text)}</li>`).join("");


  const derivedProtectiveConditions = [];
  if (data.monthsBelowReserve.length) {
    derivedProtectiveConditions.push(
      `Duy trì tiền cuối kỳ tối thiểu ${formatMoney(data.reserveMinimum)}; bố trí tối đa ${formatMoney(data.fundingNeed)} trước các tháng ${data.monthsBelowReserve.join(", ")}.`
    );
  }
  if ((marginGapRatio ?? 0) < 0) {
    derivedProtectiveConditions.push("Chỉ ký sau khi có phương án cải thiện biên lợi nhuận đạt mục tiêu.");
  }
  if (data.missingFields.length) {
    derivedProtectiveConditions.push(`Bổ sung dữ liệu: ${data.missingFields.join(", ")}.`);
  }
  const protectiveConditions = data.protectiveConditions.length
    ? data.protectiveConditions
    : derivedProtectiveConditions.length
      ? derivedProtectiveConditions
      : ["Tiếp tục giám sát dòng tiền và tuân thủ các điều kiện đã phê duyệt."];
  byId("protectiveConditions").textContent = protectiveConditions.join(" ");


  const recommendations = recommendationList(data);
  byId("recommendations").innerHTML = recommendations.map((text) => `<li>${escapeText(text)}</li>`).join("");


  // Chỉ hiện mức độ Cao/Trung bình/Thấp kèm điểm số ở thẻ Input Data này.
  const riskLabel = data.riskLevel === "HIGH" || data.riskLevel === "CRITICAL" ? "Cao" : data.riskLevel === "MEDIUM" ? "Trung bình" : data.riskLevel === "LOW" ? "Thấp" : "Chưa rõ";
  const adjustedRiskScore = numberValue(data.riskScore, NaN) + state.riskAdjustment;
  byId("riskLevel").textContent = Number.isFinite(adjustedRiskScore)
    ? `${riskLabel} (${adjustedRiskScore} điểm${state.riskAdjustment ? ", +2 do bỏ qua dữ liệu" : ""})`
    : riskLabel;

  byId("riskScore").textContent = Number.isFinite(adjustedRiskScore)
    ? String(Math.round(adjustedRiskScore))
    : "—";


  // confidenceScore hiển thị ở đây là confidence_score CUỐI CÙNG do Decision &
  // Partner Agent tổng hợp theo công thức trọng số (dữ liệu đầy đủ, tính toán
  // tài chính, nguồn bằng chứng thật, độ rõ ràng rủi ro, độ phù hợp đối tác) —
  // KHÔNG đo mức độ rủi ro thấp/cao, nên risk cao vẫn có thể đi kèm confidence cao.
  byId("confidenceScore").textContent = formatPercent(data.confidenceScore, 0);
  byId("confidenceScore").title = data.confidenceExplanation
    || "Độ tin cậy của KẾT QUẢ (dữ liệu đủ, tính toán đúng nguồn, bằng chứng thật, rủi ro rõ ràng, đối tác phù hợp) — không phải mức độ rủi ro thấp hay cao.";


  // Chỉ số Critical đọc trực tiếp từ bank_transactions qua backend.
  // Kết quả chạy agent không được phép ghi đè chỉ số cấp OPC này.
  renderAnomalyMetric();

  const financeConfidence = firstDefined(data.outputs.finance_confidence, data.finance.confidence_score, data.outputs.confidence_score, data.confidenceScore);
  const riskConfidence = firstDefined(data.outputs.risk_confidence, data.outputs.confidence_score, data.confidenceScore);
  const decisionConfidence = firstDefined(data.outputs.decision_confidence, data.decision.confidence_score, data.outputs.confidence_score, data.confidenceScore);
  setProgress("finance", financeConfidence);
  setProgress("risk", riskConfidence);
  setProgress("decision", decisionConfidence);


  byId("financeAgentIcon").textContent = "✓";
  byId("riskAgentIcon").textContent = data.riskLevel === "HIGH" || data.riskLevel === "CRITICAL" ? "⚠" : "✓";
  byId("decisionAgentIcon").textContent = "✓";
  byId("financeAgentText").textContent = data.financeAnalysis || data.message || `Đã tính toán tài chính cho ${state.contractId}.`;


  // Diễn giải rủi ro bằng lý do thật từ backend; fallback nêu rõ số giao
  // dịch bất thường thật (không phải đếm gộp cờ + trường thiếu).
  const displayedAnomalyCount = Math.max(
    data.anomalyTransactionCount,
    Array.isArray(state.anomalyTransactions) ? state.anomalyTransactions.length : 0
  );
  byId("riskAgentText").textContent = data.decisionReasons[1]
    || `${riskLabel} rủi ro (${displayedAnomalyCount} giao dịch bất thường); ${data.monthsBelowReserve.length} tháng dòng tiền dưới mức dự trữ.`;


  byId("decisionAgentText").textContent = `Quyết định: ${data.agentDecision}.`;


  // Theo yêu cầu: không hiển thị dãy tag mã cờ thô (WORKING_CAPITAL_REQUIRED,
  // RR-002_CASH_BELOW_RESERVE...) trên Agent Workflow — chỉ giữ lại phần văn
  // xuôi ở financeAgentText/riskAgentText phía trên. Mã cờ + insight vẫn còn
  // đầy đủ ở mục "Kiểm tra dữ liệu" (renderChecks) cho ai cần xem chi tiết.
  byId("financeFlags").innerHTML = "";
  byId("financeFlags").style.display = "none";
  byId("riskTags").innerHTML = "";
  byId("riskTags").style.display = "none";


  byId("approvalState").textContent = data.approvalRequired ? "Cần phê duyệt" : "Không bắt buộc";
  byId("founderRequestedAmount").textContent = formatMoney(data.requestedAmount);


  const requestedAmountNumber = numberValue(data.requestedAmount, NaN);
  byId("approvalText").textContent = !Number.isFinite(requestedAmountNumber)
    ? "Chưa lấy được dữ liệu requested_amount."
    : requestedAmountNumber > 300_000_000
      ? `${formatMoney(data.requestedAmount)} > 300 triệu — Cần Founder phê duyệt.`
      : data.approvalRequired
        ? `${formatMoney(data.requestedAmount)} — Yêu cầu phê duyệt theo Workflow.`
        : `${formatMoney(data.requestedAmount)} (Không vượt ngưỡng 300 triệu).`;


  byId("cashflowViolation").textContent = data.monthsBelowReserve.length
    ? `⚠ Vi phạm RR-002 — ${data.monthsBelowReserve.join(", ")}`
    : "Không phát hiện tháng dưới mức dự trữ.";


  byId("rawOutput").textContent = JSON.stringify(data.outputs, null, 2);
  byId("workflowRunId").textContent = `Workflow run: ${data.workflowRunId || "—"}`;
  byId("lastRun").textContent = `Thực thi gần nhất: ${new Date().toLocaleTimeString("vi-VN")}`;


  drawCashflowChart(data.chartRows);
}


function compactAxis(value) {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(0)}M`;
  return String(Math.round(value));
}


function drawCashflowChart(rows) {
  const canvas = byId("cashflowChart");
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(320, Math.round(rect.width * ratio));
  canvas.height = Math.max(220, Math.round(rect.height * ratio));


  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  const width = canvas.width / ratio;
  const height = canvas.height / ratio;
  ctx.clearRect(0, 0, width, height);


  if (!Array.isArray(rows) || !rows.length) {
    ctx.fillStyle = "#6c788a";
    ctx.font = "14px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("Chưa có monthly_summary để vẽ biểu đồ", width / 2, height / 2);
    return;
  }


  const normalized = rows.map((row, index) => ({
    month: row.month || row.period || `T${index + 1}`,
    cashIn: numberValue(firstDefined(row.expected_cash_in, row.cash_in, row.inflow)),
    cashOut: numberValue(firstDefined(row.expected_cash_out, row.cash_out, row.outflow)),
    closing: numberValue(firstDefined(row.projected_closing_cash, row.closing_cash, row.balance)),
  }));


  const values = normalized.flatMap((row) => [row.cashIn, -row.cashOut, row.closing]);
  let minValue = Math.min(0, ...values);
  let maxValue = Math.max(0, ...values);
  if (minValue === maxValue) maxValue = minValue + 1;
  const range = maxValue - minValue;
  minValue -= range * 0.12;
  maxValue += range * 0.12;


  const margin = { top: 18, right: 18, bottom: 42, left: 58 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const y = (value) => margin.top + ((maxValue - value) / (maxValue - minValue)) * plotHeight;
  const zeroY = y(0);


  ctx.font = "11px system-ui";
  ctx.strokeStyle = "#e3e7ed";
  ctx.fillStyle = "#657084";
  ctx.lineWidth = 1;
  ctx.textAlign = "right";


  for (let i = 0; i <= 5; i += 1) {
    const value = maxValue - ((maxValue - minValue) * i / 5);
    const lineY = y(value);
    ctx.beginPath();
    ctx.moveTo(margin.left, lineY);
    ctx.lineTo(width - margin.right, lineY);
    ctx.stroke();
    ctx.fillText(compactAxis(value), margin.left - 8, lineY + 4);
  }


  ctx.strokeStyle = "#7d8590";
  ctx.beginPath();
  ctx.moveTo(margin.left, zeroY);
  ctx.lineTo(width - margin.right, zeroY);
  ctx.stroke();


  const slot = plotWidth / normalized.length;
  const barWidth = Math.min(28, slot * 0.25);


  normalized.forEach((row, index) => {
    const centerX = margin.left + slot * (index + 0.5);


    ctx.fillStyle = "#54d88d";
    const inTop = y(row.cashIn);
    ctx.fillRect(centerX - barWidth - 2, inTop, barWidth, Math.max(1, zeroY - inTop));


    ctx.fillStyle = "#ef7070";
    const outBottom = y(-row.cashOut);
    ctx.fillRect(centerX + 2, zeroY, barWidth, Math.max(1, outBottom - zeroY));


    ctx.fillStyle = "#5d6674";
    ctx.textAlign = "center";
    ctx.fillText(String(row.month).replace("2026-", "T"), centerX, height - 15);
  });


  ctx.strokeStyle = "#5d6470";
  ctx.fillStyle = "#5d6470";
  ctx.lineWidth = 2;
  ctx.beginPath();
  normalized.forEach((row, index) => {
    const centerX = margin.left + slot * (index + 0.5);
    const lineY = y(row.closing);
    if (index === 0) ctx.moveTo(centerX, lineY);
    else ctx.lineTo(centerX, lineY);
  });
  ctx.stroke();


  normalized.forEach((row, index) => {
    const centerX = margin.left + slot * (index + 0.5);
    const lineY = y(row.closing);
    ctx.beginPath();
    ctx.arc(centerX, lineY, 3.5, 0, Math.PI * 2);
    ctx.fill();
  });
}


function renderAnomalyMetric() {
  const metric = byId("anomalyCount");
  if (!state.anomalyMetricLoaded) {
    metric.textContent = "—";
    metric.title = "Đang tải giao dịch bất thường từ bank_transactions.";
    return;
  }

  const rows = Array.isArray(state.anomalyTransactions)
    ? state.anomalyTransactions
    : [];
  metric.textContent = String(rows.length);
  metric.title = rows.length
    ? rows.map((transaction) => {
        const transactionId = firstDefined(
          transaction.txn_id,
          transaction.transaction_id,
          transaction.id,
          "Không rõ mã"
        );
        const riskScore = numberValue(
          firstDefined(
            transaction.transaction_risk_score,
            transaction.risk_score
          ),
          NaN
        );
        const reason = firstDefined(
          transaction.reason,
          transaction.description,
          transaction.risk_reason,
          transaction.status,
          ""
        );
        const scoreText = Number.isFinite(riskScore)
          ? " · risk score " + Math.round(riskScore)
          : "";
        return transactionId + scoreText + (reason ? " · " + reason : "");
      }).join("\n")
    : "Không có giao dịch bất thường trong bank_transactions.";
}


async function loadAnomalyTransactions() {
  state.anomalyMetricLoaded = false;
  renderAnomalyMetric();

  try {
    const response = await requestJson("/api/bank-transactions/anomalies");
    state.anomalyTransactions = Array.isArray(response.data)
      ? response.data
      : [];
    state.anomalyMetricLoaded = true;
    renderAnomalyMetric();
  } catch (error) {
    state.anomalyTransactions = [];
    state.anomalyMetricLoaded = false;
    byId("anomalyCount").textContent = "—";
    byId("anomalyCount").title =
      "Không tải được bank_transactions: " + error.message;
    console.error("Không tải được giao dịch bất thường:", error);
  }
}

async function loadContracts() {
  try {
    const response = await requestJson("/api/contracts");
    const contracts = Array.isArray(response.data) ? response.data : [];
    if (!contracts.length) return;


    const select = byId("contractSelect");
    select.innerHTML = contracts.map((contract) => {
      const id = contract.contract_id || contract.id;
      const customer = contract.customer_name || contract.customer_id || "";
      return `<option value="${escapeText(id)}" data-customer="${escapeText(customer)}">${escapeText(id)}</option>`;
    }).join("");


    if (contracts.some((contract) => (contract.contract_id || contract.id) === state.contractId)) {
      select.value = state.contractId;
    } else {
      state.contractId = select.value;
    }
  } catch (error) {
    showToast(`Không tải được danh sách hợp đồng: ${error.message}`, true);
  }
}


async function analyzeSelectedContract() {
  const contractId = byId("contractSelect").value.trim().toUpperCase();
  if (!contractId) return showToast("Hãy chọn mã hợp đồng.", true);


  state.contractId = contractId;
  setLoading(true);


  try {
    const payload = await requestJson(`/api/agent/analyze/${encodeURIComponent(contractId)}`, {
      method: "POST",
    });
    renderDashboard(payload);
    showToast(`Đã tải dữ liệu hợp đồng ${contractId}.`);
  } catch (error) {
    byId("workflowStatus").className = "status-pill status-error";
    byId("workflowStatus").textContent = "Lỗi";
    byId("agentState").textContent = "Thất bại";
    showToast(error.message, true);
  } finally {
    setLoading(false);
  }
}


function openModal({ step, title, message, fields = "", actions }) {
  byId("modalStep").textContent = step;
  byId("modalTitle").textContent = title;
  byId("modalMessage").textContent = message;
  byId("modalFields").innerHTML = fields;
  byId("modalActions").innerHTML = actions.map((action) =>
    `<button type="button" class="button ${action.className || "button-outline"}" data-modal-action="${action.value}">${escapeText(action.label)}</button>`
  ).join("");
  byId("workflowModal").hidden = false;
  return new Promise((resolve) => {
    const finish = (value) => {
      byId("workflowModal").hidden = true;
      byId("modalActions").onclick = null;
      byId("modalClose").onclick = null;
      resolve(value);
    };
    byId("modalActions").onclick = (event) => {
      const button = event.target.closest("[data-modal-action]");
      if (button) finish(button.dataset.modalAction);
    };
    byId("modalClose").onclick = () => finish(null);
  });
}


async function rerunAgent1(body) {
  setLoading(true);
  try {
    const payload = await requestJson(`/api/agent/analyze/${encodeURIComponent(state.contractId)}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    renderDashboard(payload);
    return payload;
  } finally {
    setLoading(false);
  }
}


async function handleMissingData(missingFields) {
  const choice = await openModal({
    step: "Popup 1 · Dữ liệu còn thiếu",
    title: "Cần bổ sung dữ liệu",
    message: `Các trường còn thiếu: ${missingFields.join(", ")}.\nNếu bỏ qua, điểm rủi ro hiển thị sẽ tăng thêm 2 điểm.`,
    actions: [
      { value: "supplement", label: "Bổ sung", className: "button-primary" },
      { value: "skip", label: "Bỏ qua", className: "button-cancel" },
    ],
  });
  if (choice === "supplement") {
    const fields = missingFields.map((field, index) => `
      <label>${escapeText(field)}<input data-missing-field="${escapeText(field)}" id="missing-${index}" required></label>
    `).join("");
    const submit = await openModal({
      step: "Popup 4 · Bổ sung dữ liệu",
      title: "Nhập dữ liệu còn thiếu",
      message: "Dữ liệu này sẽ được gửi lại cho Agent 1 để phân tích lại.",
      fields,
      actions: [
        { value: "submit", label: "Gửi và chạy lại", className: "button-primary" },
        { value: "cancel", label: "Hủy", className: "button-cancel" },
      ],
    });
    if (submit !== "submit") return false;
    const supplementalData = {};
    document.querySelectorAll("[data-missing-field]").forEach((input) => {
      supplementalData[input.dataset.missingField] = input.value.trim();
    });
    if (Object.values(supplementalData).some((value) => !value)) {
      showToast("Vui lòng nhập đầy đủ dữ liệu cần bổ sung.", true);
      return false;
    }
    state.riskAdjustment = 0;
    await rerunAgent1({ supplemental_data: supplementalData });
    return false;
  }
  if (choice === "skip") {
    state.riskAdjustment = 2;
    await rerunAgent1({ skip_missing_data: true });
    return true;
  }
  return false;
}


async function callAgent2(founderDecision, externalSendConfirmation = null) {
  setLoading(true);
  try {
    const outputs = state.latestPayload?.outputs
      || state.latestPayload?.data?.outputs
      || state.latestPayload?.dify_response?.data?.outputs
      || {};
    const decisionPackageRaw = firstDefined(
      outputs.decision_package,
      outputs.output_payload,
      outputs.final_frontend_payload_json,
      outputs.decision
    );
    const decisionPackage = parseJsonMaybe(decisionPackageRaw);
    const payload = { founder_decision: founderDecision };
    if (externalSendConfirmation) payload.external_send_confirmation = externalSendConfirmation;

    const decisionId = firstDefined(outputs.decision_id, decisionPackage.decision_id);
    const caseId = firstDefined(outputs.case_id, decisionPackage.case_id);
    const traceId = firstDefined(outputs.trace_id, decisionPackage.trace_id);
    if (decisionId) payload.decision_id = String(decisionId);
    if (caseId) payload.case_id = String(caseId);
    if (traceId) payload.trace_id = String(traceId);
    if (decisionPackageRaw) {
      payload.decision_package = typeof decisionPackageRaw === "string"
        ? decisionPackageRaw
        : JSON.stringify(decisionPackageRaw);
    }

    const response = await requestJson(`/api/agent/founder-decision/${encodeURIComponent(state.contractId)}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    byId("rawOutput").textContent = JSON.stringify(response.outputs, null, 2);
    byId("decisionAgentText").textContent = `Founder đã chọn: ${founderDecision}.`;
    return response;
  } finally {
    setLoading(false);
  }
}


async function handleAcceptFlow() {
  if (!state.latestPayload) return showToast("Hãy chạy phân tích trước khi duyệt hợp đồng.", true);
  let data = normalizePayload(state.latestPayload);
  if (data.missingFields.length) {
    const skipped = await handleMissingData(data.missingFields);
    if (!skipped) return;
    data = normalizePayload(state.latestPayload);
  }


  const founderDecision = await openModal({
    step: "Popup 2 · Quyết định Founder",
    title: "Chọn quyết định cho hợp đồng",
    message: `Hợp đồng ${state.contractId} · Số tiền đề nghị ${formatFullMoney(data.requestedAmount)}.`,
    actions: [
      { value: "approve", label: "Duyệt", className: "button-accept" },
      { value: "request_more_info", label: "Yêu cầu thêm thông tin", className: "button-more" },
      { value: "reject", label: "Từ chối", className: "button-reject" },
    ],
  });
  if (!founderDecision) return;
  if (founderDecision !== "approve") {
    await callAgent2(founderDecision);
    showToast("Đã gửi quyết định của Founder tới Agent 2.");
    return;
  }


  const aboveThreshold = numberValue(data.requestedAmount) > 300_000_000;
  const confirmation = await openModal({
    step: "Popup 3 · Xác nhận gửi ngoài",
    title: aboveThreshold ? "Xác nhận gửi hồ sơ ngân hàng" : "Xác nhận duyệt hợp đồng",
    message: aboveThreshold
      ? "Số tiền đề nghị trên 300 triệu. Bạn có xác nhận gửi hồ sơ tới ngân hàng không?"
      : "Số tiền đề nghị dưới 300 triệu. Bạn có xác nhận duyệt không? Hồ sơ sẽ được tự động gửi tới ngân hàng.",
    actions: [
      { value: "confirm", label: "Xác nhận", className: "button-accept" },
      { value: "cancel", label: "Hủy", className: "button-cancel" },
    ],
  });
  if (!confirmation) return;
  await callAgent2("approve", confirmation);
  if (confirmation === "confirm") showToast("Đã duyệt và tự động gửi hồ sơ đến ngân hàng.");
  else showToast("Đã ghi nhận duyệt nhưng hủy gửi hồ sơ đến ngân hàng.");
}


async function submitDecision(decision) {
  if (!state.latestPayload) {
    return showToast("Hãy chạy phân tích trước khi lưu quyết định.", true);
  }


  const workflowRunId = state.latestPayload.dify_response?.workflow_run_id
    || state.latestPayload.dify_response?.data?.id
    || null;


  try {
    await requestJson(`/api/contracts/${encodeURIComponent(state.contractId)}/decision`, {
      method: "POST",
      body: JSON.stringify({
        decision,
        workflow_run_id: workflowRunId,
        decided_at: new Date().toISOString(),
        source: "opc-web-dashboard",
      }),
    });
    showToast(`Đã lưu quyết định ${decision} cho ${state.contractId}.`);
  } catch (error) {
    showToast(error.message, true);
  }
}


function bindEvents() {
  byId("logoutButton").addEventListener("click", async () => {
    const button = byId("logoutButton");
    button.disabled = true;
    try {
      await requestJson("/api/auth/logout", { method: "POST" });
    } catch (error) {
      console.warn("Không thể gọi API đăng xuất:", error);
    } finally {
      // Trên GitHub Pages "/" là chính index.html (dashboard), không phải
      // trang login của backend Render -> phải trỏ về login.html tại chỗ.
      window.location.replace("login.html");
    }
  });
  byId("analyzeButton").addEventListener("click", analyzeSelectedContract);
  byId("contractSelect").addEventListener("change", () => {
    state.contractId = byId("contractSelect").value;
    const option = byId("contractSelect").selectedOptions[0];
    if (option?.dataset.customer) byId("customerName").value = option.dataset.customer;

    // Không giữ số liệu của hợp đồng trước khi người dùng vừa đổi lựa chọn.
    state.latestPayload = null;
    state.chartRows = [];
    state.riskAdjustment = 0;
    [
      "paymentReliability", "strategicValue", "grossMargin", "contractValue",
      "fundingNeed", "reserveMinimum", "riskLevel", "confidenceScore",
      "riskScore", "founderRequestedAmount"
    ].forEach((id) => { byId(id).textContent = "—"; });
    setProgress("finance", null);
    setProgress("risk", null);
    setProgress("decision", null);
    byId("workflowStatus").className = "status-pill status-idle";
    byId("workflowStatus").textContent = "Chưa chạy";
    byId("agentState").textContent = "Chờ phân tích";
    byId("dataChecks").innerHTML = "";
    byId("keyFindings").innerHTML = "";
    byId("recommendations").innerHTML = "";
    byId("protectiveConditions").textContent = "";
    byId("financeAgentText").textContent = "Chưa chạy phân tích tài chính.";
    byId("riskAgentText").textContent = "Chưa có đánh giá rủi ro.";
    byId("decisionAgentText").textContent = "Chưa có quyết định.";
    byId("approvalText").textContent = "Chưa có kết quả phân tích.";
    byId("cashflowViolation").textContent = "";
    byId("rawOutput").textContent = "";
    byId("workflowRunId").textContent = "Workflow run: —";
    renderAnomalyMetric();
    drawCashflowChart([]);
  });
  document.querySelectorAll("[data-decision]").forEach((button) => {
    button.addEventListener("click", () => button.dataset.decision === "ACCEPT"
      ? handleAcceptFlow().catch((error) => showToast(error.message, true))
      : submitDecision(button.dataset.decision));
  });
  window.addEventListener("resize", () => drawCashflowChart(state.chartRows));
}


async function init() {
  bindEvents();
  drawCashflowChart([]);
  await Promise.all([
    loadContracts(),
    loadAnomalyTransactions(),
  ]);
}


document.addEventListener("DOMContentLoaded", init);
