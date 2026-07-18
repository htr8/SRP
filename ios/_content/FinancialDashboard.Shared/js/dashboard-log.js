// Small, dependency-free helpers for the Diagnostic Logs modal (DashboardLogModal.razor).
// Shared by every head via _content/FinancialDashboard.Shared/js/dashboard-log.js.
window.dashboardLog = window.dashboardLog || {
    // Scrolls the element with the given id into view (used by "Jump to last error").
    scrollToAnchor: function (id) {
        try {
            const el = document.getElementById(id);
            if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        } catch {
            /* best effort — never throw into Blazor interop */
        }
    }
};
