// Contact tabs
// Switches between the signup / wholesale / general-inquiries panels on the
// contact page, and submits each panel's plain <form> entirely client-side,
// straight to Klaviyo's public Client API (see contact-tabs.liquid — there
// is no `{% form 'contact' %}`, so nothing here ever hits Shopify or
// navigates the browser away). On success, the panel's own `<template
// class="contact-tabs__success-template">` (its copy authored once in
// Liquid — see contact-tabs.liquid) is cloned in over the form; on failure,
// its `.contact-tabs__error-template` is shown above the form instead so
// the visitor can retry.
//
// Every failed subscribe call below logs Klaviyo's own response body to the
// console (not just the status code) — that detail is what diagnosed the
// two rounds of 400s this endpoint gave over an incorrectly-placed
// `subscriptions` field (see #subscribeToKlaviyo), and it's the fastest way
// to a fix if any field here ever gets rejected too: check that output
// first, rather than guessing a new payload shape from scratch.
const KLAVIYO_REVISION = '2024-10-15';

// Klaviyo profile attributes with a dedicated top-level field, as opposed to
// a custom one nested under `properties`. Keyed to each field's own
// `data-klaviyo-field` value in contact-tabs.liquid.
const KLAVIYO_NATIVE_PROFILE_ATTRIBUTES = new Set(['first_name', 'last_name', 'phone_number']);

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
    // successful submit replaces its own form with the success template, so
    // a listener attached to today's form element wouldn't be around for a
    // second submission anyway.
    this.addEventListener('submit', this.#handleFormSubmit, { signal });

    // Delegated the same way as submit: the phone field is re-created any
    // time a panel's success/error template swaps the form, so a listener
    // bound to today's input wouldn't survive that either.
    this.addEventListener('input', this.#handlePhoneInput, { signal });
  }

  disconnectedCallback() {
    this.#controller.abort();
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
   * Wholesale's phone field (the only `type="tel"` input this component
   * renders) only accepts digits and the punctuation real phone numbers use.
   * `pattern` on its own (contact-tabs.liquid) only blocks submission —
   * letters would otherwise still be typable — so this strips anything else
   * as it's typed instead.
   * @param {Event} event
   */
  #handlePhoneInput = (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'tel') return;

    const sanitized = input.value.replace(/[^0-9+()\-.\s]/g, '');
    if (sanitized !== input.value) input.value = sanitized;
  };

  /**
   * A filled honeypot means a bot filled in a field real visitors never see
   * (contact-tabs.liquid), so that submission is dropped outright — nothing
   * is sent to Klaviyo, and no message is shown either way.
   * @param {SubmitEvent} event
   */
  #handleFormSubmit = (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.classList.contains('contact-tabs__form')) return;

    event.preventDefault();

    const honeypot = /** @type {HTMLInputElement | null} */ (form.querySelector('[data-klaviyo-honeypot]'))
      ?.value.trim();
    if (honeypot) return;

    // The browser's own validation (the email field is `required`) still
    // runs even with the form's `novalidate` attribute, because that
    // attribute only suppresses the browser's *own* submit-blocking — it
    // has no effect on this explicit check.
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    const panel = form.closest('.contact-tabs__panel');
    if (!panel) return;

    const email = /** @type {HTMLInputElement | null} */ (form.querySelector('[data-klaviyo-email]'))?.value.trim();
    const listId = form.dataset.klaviyoListId;
    const publicKey = this.dataset.klaviyoPublicKey;

    if (!email || !listId || !publicKey) {
      this.#showError(panel);
      return;
    }

    const submitButton = /** @type {HTMLButtonElement | null} */ (form.querySelector('button[type="submit"]'));
    if (submitButton) submitButton.disabled = true;

    this.#subscribeToKlaviyo({ publicKey, listId, email, form })
      .then(() => this.#showSuccess(panel, form))
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.error('[contact-tabs] Klaviyo subscription failed:', error);
        this.#showError(panel);
        if (submitButton) submitButton.disabled = false;
      });
  };

  /**
   * @param {{ publicKey: string, listId: string, email: string, form: HTMLFormElement }} params
   */
  #subscribeToKlaviyo({ publicKey, listId, email, form }) {
    const profileAttributes = { email };
    const properties = {};

    form.querySelectorAll('[data-klaviyo-field]').forEach((field) => {
      const key = /** @type {HTMLElement} */ (field).dataset.klaviyoField;
      const value = /** @type {HTMLInputElement | HTMLTextAreaElement} */ (field).value.trim();
      if (!key || !value) return;

      if (KLAVIYO_NATIVE_PROFILE_ATTRIBUTES.has(key)) {
        profileAttributes[key] = value;
      } else {
        properties[key] = value;
      }
    });

    if (Object.keys(properties).length > 0) profileAttributes.properties = properties;

    return fetch(`https://a.klaviyo.com/client/subscriptions/?company_id=${encodeURIComponent(publicKey)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        revision: KLAVIYO_REVISION,
      },
      body: JSON.stringify({
        data: {
          type: 'subscription',
          attributes: {
            // No explicit `subscriptions` / consent field: Klaviyo rejected
            // it both nested inside `profile` ("not a valid field for the
            // resource 'profile'") and as a sibling of `profile` here ("not
            // a valid field for the resource 'subscription'"). Subscribing
            // via the list relationship below is apparently the consent
            // action itself on this endpoint.
            profile: {
              data: {
                type: 'profile',
                attributes: profileAttributes,
              },
            },
          },
          relationships: {
            list: { data: { type: 'list', id: listId } },
          },
        },
      }),
    }).then((response) => {
      if (response.ok) return;

      return response.text().then((body) => {
        throw new Error(`Klaviyo responded with ${response.status}: ${body}`);
      });
    });
  }

  /**
   * @param {Element} panel
   * @param {HTMLFormElement} form
   */
  #showSuccess(panel, form) {
    const template = /** @type {HTMLTemplateElement | null} */ (
      panel.querySelector('.contact-tabs__success-template')
    );
    if (!template) return;

    form.hidden = true;
    const message = /** @type {DocumentFragment} */ (template.content.cloneNode(true));
    panel.appendChild(message);
    /** @type {HTMLElement | null} */ (panel.querySelector('.contact-form__success'))?.focus();
  }

  /**
   * @param {Element} panel
   */
  #showError(panel) {
    panel.querySelector('.contact-form__error')?.remove();

    const template = /** @type {HTMLTemplateElement | null} */ (panel.querySelector('.contact-tabs__error-template'));
    if (!template) return;

    const message = /** @type {DocumentFragment} */ (template.content.cloneNode(true));
    panel.insertBefore(message, panel.querySelector('form'));
    /** @type {HTMLElement | null} */ (panel.querySelector('.contact-form__error'))?.focus();
  }
}

if (!customElements.get('contact-tabs')) {
  customElements.define('contact-tabs', ContactTabs);
}
