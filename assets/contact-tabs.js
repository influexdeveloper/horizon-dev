// Contact tabs
// Switches between the signup / wholesale / general-inquiries panels on the
// contact page. Each panel is its own `{% form 'contact' %}`, so switching
// tabs only ever toggles visibility — it never touches form state. Each
// form also fires a Klaviyo list-subscribe alongside its normal Shopify
// submission, keyed off the section's public API key and that panel's own
// list ID (both set in the theme editor — see contact-tabs.liquid's schema).
const KLAVIYO_REVISION = '2024-10-15';

class ContactTabs extends HTMLElement {
  #controller = new AbortController();

  /** @type {HTMLButtonElement[]} */
  get #tabs() {
    return Array.from(this.querySelectorAll('[role="tab"]'));
  }

  /** @type {HTMLElement[]} */
  get #panels() {
    return Array.from(this.querySelectorAll('[role="tabpanel"]'));
  }

  /** @type {HTMLFormElement[]} */
  get #forms() {
    return Array.from(this.querySelectorAll('form'));
  }

  connectedCallback() {
    const { signal } = this.#controller;

    this.#tabs.forEach((tab) => {
      tab.addEventListener('click', this.#handleTabClick, { signal });
    });

    this.#forms.forEach((form) => {
      form.addEventListener('submit', this.#handleFormSubmit, { signal });
    });

    this.#activateSubmittedPanel();
  }

  disconnectedCallback() {
    this.#controller.abort();
  }

  /**
   * After a contact form submission, Shopify re-renders the page with that
   * one panel's `{% form %}` carrying an error or success message — the tab
   * that opens by default is always the first one (see contact-tabs.liquid),
   * so if a *different* panel is the one holding that message, switch to it.
   */
  #activateSubmittedPanel() {
    const message = this.querySelector('.contact-form__error, .contact-form__success');
    const panel = message?.closest('[role="tabpanel"]');
    if (!panel) return;

    const tab = this.#tabs.find((t) => t.getAttribute('aria-controls') === panel.id);
    if (tab) this.#activate(tab);
  }

  /**
   * @param {MouseEvent} event
   */
  #handleTabClick = (event) => {
    const tab = /** @type {HTMLButtonElement} */ (event.currentTarget);
    this.#activate(tab);
  };

  /**
   * Fires alongside the form's normal submission to Shopify — it never calls
   * `preventDefault()`, so the browser still navigates to /contact right
   * after. `keepalive` is what lets this particular request finish in the
   * background despite that navigation, the same way `navigator.sendBeacon`
   * would; a plain `fetch` here would otherwise usually be cancelled
   * mid-flight. A failed or skipped call must never block or surface an
   * error on top of the Shopify submission, so every exit here is silent.
   * @param {SubmitEvent} event
   */
  #handleFormSubmit = (event) => {
    const form = /** @type {HTMLFormElement} */ (event.currentTarget);
    const publicKey = this.dataset.klaviyoPublicKey;
    const listId = form.dataset.klaviyoListId;
    const email = /** @type {HTMLInputElement | null} */ (
      form.querySelector('input[type="email"]')
    )?.value.trim();

    if (!publicKey || !listId || !email) return;

    fetch(`https://a.klaviyo.com/client/subscriptions/?company_id=${encodeURIComponent(publicKey)}`, {
      method: 'POST',
      keepalive: true,
      headers: {
        'Content-Type': 'application/json',
        revision: KLAVIYO_REVISION,
      },
      body: JSON.stringify({
        data: {
          type: 'subscription',
          attributes: {
            profile: {
              data: {
                type: 'profile',
                attributes: {
                  email,
                  subscriptions: {
                    email: { marketing: { consent: 'SUBSCRIBED' } },
                  },
                },
              },
            },
          },
          relationships: {
            list: { data: { type: 'list', id: listId } },
          },
        },
      }),
    }).catch(() => {});
  };

  /**
   * @param {HTMLButtonElement} tab
   */
  #activate(tab) {
    const panelId = tab.getAttribute('aria-controls');

    this.#tabs.forEach((t) => {
      const isActive = t === tab;

      t.setAttribute('aria-selected', String(isActive));
      t.classList.toggle('contact-tabs__tab--active', isActive);
    });

    this.#panels.forEach((panel) => {
      const isActive = panel.id === panelId;

      panel.classList.toggle('contact-tabs__panel--active', isActive);
      panel.hidden = !isActive;
    });
  }
}

if (!customElements.get('contact-tabs')) {
  customElements.define('contact-tabs', ContactTabs);
}
