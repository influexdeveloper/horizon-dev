// Contact tabs
// Switches between the signup / wholesale / general-inquiries panels on the
// contact page, and submits each panel's `{% form 'contact' %}` in the
// background instead of letting it navigate the browser away: the request
// still goes to Shopify for real (validation, notification emails, and
// Klaviyo eligibility are all unchanged), but the response is fetched and
// only that one panel's rendered result — an error, or the tab's own
// "SUBSCRIPTION CONFIRMED" / "Thank you for contacting us" copy, both from
// contact-tabs.liquid — is swapped into the page in place of a redirect.
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

  connectedCallback() {
    const { signal } = this.#controller;

    this.#tabs.forEach((tab) => {
      tab.addEventListener('click', this.#handleTabClick, { signal });
    });

    // Delegated on the component itself, rather than bound per-form: a
    // submit replaces its own panel's content (fresh form markup included),
    // so a listener attached to today's form element wouldn't survive that
    // swap for a second submission.
    this.addEventListener('submit', this.#handleFormSubmit, { signal });

    this.#activateSubmittedPanel();
  }

  disconnectedCallback() {
    this.#controller.abort();
  }

  /**
   * Covers the case where JS never got this far — the honeypot fetch failed
   * and fell back to a real submit, or the script simply hadn't loaded yet.
   * Shopify then re-renders the page with that one panel's `{% form %}`
   * carrying an error or success message on a normal full-page load; the tab
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

  /**
   * A filled honeypot means a bot filled in a field real visitors never see
   * (contact-tabs.liquid), so that submission is dropped outright — nothing
   * is sent to Shopify or Klaviyo. A genuine submission is always intercepted
   * (this always calls `preventDefault()`): the fetch below is what actually
   * sends it on, in place of the browser's own navigation.
   * @param {SubmitEvent} event
   */
  #handleFormSubmit = (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.classList.contains('contact-tabs__form')) return;

    event.preventDefault();

    const honeypot = /** @type {HTMLInputElement | null} */ (
      form.querySelector('input[name="contact[website]"]')
    )?.value.trim();
    if (honeypot) return;

    const panel = form.closest('[role="tabpanel"]');
    if (!panel) return;

    // Captured now, off the live form, because a successful swap below
    // replaces this exact element with the fetched response's markup.
    const klaviyoPublicKey = this.dataset.klaviyoPublicKey;
    const klaviyoListId = form.dataset.klaviyoListId;
    const email = /** @type {HTMLInputElement | null} */ (
      form.querySelector('input[type="email"]')
    )?.value.trim();

    const submitButton = /** @type {HTMLButtonElement | null} */ (form.querySelector('button[type="submit"]'));
    if (submitButton) submitButton.disabled = true;

    fetch(form.action, {
      method: 'POST',
      credentials: 'same-origin',
      body: new FormData(form),
    })
      .then((response) => response.text())
      .then((html) => {
        const fetchedPanel = new DOMParser().parseFromString(html, 'text/html').getElementById(panel.id);

        // Shopify didn't return the page shape this was built against —
        // safest to fall back to a real submission rather than show nothing.
        if (!fetchedPanel) {
          form.submit();
          return;
        }

        const succeeded = !fetchedPanel.querySelector('.contact-form__error');
        panel.innerHTML = fetchedPanel.innerHTML;
        /** @type {HTMLElement | null} */ (
          panel.querySelector('.contact-form__error, .contact-form__success')
        )?.focus();

        if (succeeded) this.#subscribeToKlaviyo({ klaviyoPublicKey, klaviyoListId, email });
      })
      .catch(() => {
        // The submission may already have gone through server-side even
        // though this fetch itself failed (a dropped connection, offline,
        // etc.) — a real navigation is the only way left to show the
        // visitor an accurate outcome instead of a silent dead end.
        form.submit();
      });
  };

  /**
   * Fired only once the fetch above has confirmed the Shopify submission
   * itself succeeded — never blindly on submit — so an invalid entry never
   * reaches Klaviyo's list. A failed or skipped call must never surface an
   * error on top of a Shopify submission that already succeeded, so every
   * exit here is silent.
   * @param {{ klaviyoPublicKey: string | undefined, klaviyoListId: string | undefined, email: string | undefined }} params
   */
  #subscribeToKlaviyo({ klaviyoPublicKey, klaviyoListId, email }) {
    if (!klaviyoPublicKey || !klaviyoListId || !email) return;

    fetch(`https://a.klaviyo.com/client/subscriptions/?company_id=${encodeURIComponent(klaviyoPublicKey)}`, {
      method: 'POST',
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
            list: { data: { type: 'list', id: klaviyoListId } },
          },
        },
      }),
    }).catch(() => {});
  }
}

if (!customElements.get('contact-tabs')) {
  customElements.define('contact-tabs', ContactTabs);
}
