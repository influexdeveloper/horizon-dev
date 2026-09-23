// Email signup (footer newsletter block, and anywhere else the block is
// used). Only ever rendered when the block has a Klaviyo list ID configured
// (blocks/email-signup.liquid) — with no list ID, the block uses Shopify's
// native `{% form 'customer' %}` directly and this element isn't in the
// page at all. Mirrors contact-tabs.js's approach: a plain <form> submitted
// entirely client-side, straight to Klaviyo's public Client API, with no
// Shopify-side processing and no Shopify customer created.
const KLAVIYO_REVISION = '2024-10-15';

class EmailSignupForm extends HTMLElement {
  /** @type {HTMLFormElement | null} */
  #form = null;

  connectedCallback() {
    this.#form = this.querySelector('form');
    if (!this.#form) return;

    this.#form.addEventListener('submit', this.#handleSubmit);
  }

  /**
   * @param {SubmitEvent} event
   */
  #handleSubmit = (event) => {
    event.preventDefault();

    const form = this.#form;
    if (!form || !form.checkValidity()) {
      form?.reportValidity();
      return;
    }

    const email = /** @type {HTMLInputElement | null} */ (form.querySelector('input[name="contact[email]"]'))
      ?.value.trim();
    const listId = form.dataset.klaviyoListId;
    const publicKey = this.dataset.klaviyoPublicKey;

    if (!email || !listId || !publicKey) {
      this.#showError();
      return;
    }

    const submitButton = /** @type {HTMLButtonElement | null} */ (form.querySelector('.email-signup__button'));
    if (submitButton) submitButton.disabled = true;

    this.#subscribeToKlaviyo({ publicKey, listId, email })
      .then(() => this.#showSuccess())
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.error('[email-signup] Klaviyo subscription failed:', error);
        this.#showError();
      })
      .finally(() => {
        if (submitButton) submitButton.disabled = false;
      });
  };

  /**
   * @param {{ publicKey: string, listId: string, email: string }} params
   */
  #subscribeToKlaviyo({ publicKey, listId, email }) {
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
            profile: {
              data: {
                type: 'profile',
                attributes: { email },
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

  #showSuccess() {
    this.querySelector('.email-signup__message')?.remove();

    const template = /** @type {HTMLTemplateElement | null} */ (this.querySelector('.email-signup__success-template'));
    if (!template || !this.#form) return;

    this.#form.hidden = true;
    const message = /** @type {DocumentFragment} */ (template.content.cloneNode(true));
    this.appendChild(message);
    /** @type {HTMLElement | null} */ (this.querySelector('.email-signup__message'))?.focus();
  }

  #showError() {
    this.querySelector('.email-signup__message')?.remove();

    const template = /** @type {HTMLTemplateElement | null} */ (this.querySelector('.email-signup__error-template'));
    if (!template || !this.#form) return;

    const message = /** @type {DocumentFragment} */ (template.content.cloneNode(true));
    this.insertBefore(message, this.#form);
    /** @type {HTMLElement | null} */ (this.querySelector('.email-signup__message'))?.focus();
  }
}

if (!customElements.get('email-signup-form')) {
  customElements.define('email-signup-form', EmailSignupForm);
}
