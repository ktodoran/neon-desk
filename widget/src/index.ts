import { NeonDeskElement } from './element.js';

export { NeonDeskElement };
export type { Transport } from './transport.js';
export type { ConversationEvent } from './conversation.js';

// Loading the script twice (two tags, or a bundler and a tag) must not throw.
if (typeof customElements !== 'undefined' && customElements.get('neon-desk') === undefined) {
  customElements.define('neon-desk', NeonDeskElement);
}
