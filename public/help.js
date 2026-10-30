(() => {
  "use strict";
  const CFG = window.BAM_CONFIG || {};
  const $ = (id) => document.getElementById(id);

  const lineUrl = String(CFG.LINE_CONTACT_URL || "https://lin.ee/XB6R3kS").trim();
  const portalUrl = String(CFG.CUSTOMER_PORTAL_URL || "").trim();

  if (CFG.BRAND && $("brandName")) {
    $("brandName").textContent = CFG.BRAND;
  }

  ["helpLineBtn", "tipLineLink", "fallbackCancelLineBtn"].forEach((id) => {
    const el = $(id);
    if (el && lineUrl) el.href = lineUrl;
  });

  function resetCancelFlow() {
    $("cancelEntryWrap").hidden = false;
    $("cancelStep1").hidden = true;
    $("cancelStep2").hidden = true;
    $("cancelStep3").hidden = true;
    $("cancelStep4").hidden = true;
    document.querySelectorAll('input[name="cancelReason"]').forEach((r) => { r.checked = false; });
    $("retentionTipTrouble").hidden = true;
    $("retentionTipDevice").hidden = true;
    $("btnToCancelStep3").disabled = true;
    $("chkCancelAgree1").checked = false;
    $("chkCancelAgree2").checked = false;
    $("btnToCancelStep4").disabled = true;
  }

  $("btnStartCancelFlow").onclick = () => {
    $("cancelEntryWrap").hidden = true;
    $("cancelStep1").hidden = false;
  };

  $("btnToCancelStep2").onclick = () => {
    $("cancelStep1").hidden = true;
    $("cancelStep2").hidden = false;
  };

  document.querySelectorAll('input[name="cancelReason"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      const val = radio.value;
      $("retentionTipTrouble").hidden = val !== "trouble";
      $("retentionTipDevice").hidden = val !== "device";
      $("btnToCancelStep3").disabled = false;
    });
  });

  $("btnAbortStep2").onclick = resetCancelFlow;

  $("btnToCancelStep3").onclick = () => {
    $("cancelStep2").hidden = true;
    $("cancelStep3").hidden = false;
  };

  function syncAgreeChecks() {
    $("btnToCancelStep4").disabled = !($("chkCancelAgree1").checked && $("chkCancelAgree2").checked);
  }
  $("chkCancelAgree1").addEventListener("change", syncAgreeChecks);
  $("chkCancelAgree2").addEventListener("change", syncAgreeChecks);

  $("btnAbortStep3").onclick = resetCancelFlow;

  $("btnToCancelStep4").onclick = () => {
    $("cancelStep3").hidden = true;
    $("cancelStep4").hidden = false;
    if (portalUrl) {
      $("finalCancelPortalBtn").href = portalUrl;
      $("portalLinkWrap").hidden = false;
      $("portalReadyText").hidden = false;
      $("portalFallbackWrap").hidden = true;
    } else {
      $("portalLinkWrap").hidden = true;
      $("portalReadyText").hidden = true;
      $("portalFallbackWrap").hidden = false;
    }
  };
})();
