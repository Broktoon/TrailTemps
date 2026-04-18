/* trail-nav.js — TrailTemps
   Injects the trail selector dropdown into every trail page.
   Reads window.TRAIL_SLUG (set inline per page) to highlight the current trail.
   Mount point: <div id="trail-nav-mount"> inside .header-actions
*/

(function () {
  /* -------------------------------------------------------
     Canonical trail list — update here only when adding
     or changing trail status. Order = display order.
  ------------------------------------------------------- */
  const TRAILS = [
    // Live — alphabetical
    { slug: "appalachian-trail",        name: "Appalachian Trail",        badge: "" },
    { slug: "arizona-trail",            name: "Arizona Trail",            badge: "" },
    { slug: "florida-trail",            name: "Florida Trail",            badge: "" },
    { slug: "ice-age-trail",            name: "Ice Age Trail",            badge: "" },
    { slug: "natchez-trace-trail",      name: "Natchez Trace Trail",      badge: "" },
    { slug: "new-england-trail",        name: "New England Trail",        badge: "" },
    { slug: "north-country-trail",      name: "North Country Trail",      badge: "" },
    { slug: "pacific-crest-trail",      name: "Pacific Crest Trail",      badge: "" },
    { slug: "pacific-northwest-trail",  name: "Pacific Northwest Trail",  badge: "" },
    { slug: "potomac-heritage-trail",   name: "Potomac Heritage Trail",   badge: "" },
    // Coming soon — alphabetical
    { slug: "continental-divide-trail", name: "Continental Divide Trail", badge: "(Coming Soon)" },
  ];

  function inject() {
    const mount = document.getElementById("trail-nav-mount");
    if (!mount) return;

    const currentSlug =
      window.TRAIL_SLUG ||
      document.body?.dataset?.trail ||
      "";

    let items = "";
    for (const t of TRAILS) {
      const isCurrent = t.slug === currentSlug;

      // Determine displayed badge text
      let badgeText;
      if (isCurrent) {
        badgeText = t.badge ? `(Current \u2014 ${t.badge.replace(/^\(|\)$/g, "")})` : "(Current)";
      } else {
        badgeText = t.badge;
      }

      const currentAttr = isCurrent
        ? ' class="trail-option current" aria-current="page"'
        : ' class="trail-option"';

      items += `
          <a${currentAttr} href="/trails/${t.slug}/">
            ${t.name}${badgeText ? ` <span class="trail-status">${badgeText}</span>` : ""}
          </a>`;
    }

    mount.innerHTML = `
      <details class="trail-selector">
        <summary class="trail-selector-btn">Trail &#9660;</summary>
        <nav class="trail-selector-menu" aria-label="Trail selector">
          ${items.trim()}
          <div class="trail-divider"></div>
          <a class="trail-option" href="/index.html">Trail Selector Hub</a>
        </nav>
      </details>`;
  }

  // Run immediately if DOM is ready, otherwise wait.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", inject);
  } else {
    inject();
  }
})();
