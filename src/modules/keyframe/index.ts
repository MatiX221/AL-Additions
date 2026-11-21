import { defineModule } from '../../core/registry';
import { icon } from '../../utils/dom';

defineModule({
  id: 'keyframe',
  key: 'keyframeEnabled',
  section: 'External Links, Downloads & Mappings',
  layer: 'feature',
  requiresReload: false,
  legacy: ['keyframeEnabled'],
  title: 'Keyframe Staff List Links',
  help: 'Add a button on staff and studio pages that opens the same person or studio on Keyframe Staff List.',
  setup(ctx) {
    const ID = 'ala-keyframe-link';
    const BASE = 'https://keyframe-staff-list.com';
    const LABEL = 'Keyframe Staff List';
    const SLOT = '.filters';
    const PATHS: Record<string, string> = { staff: 'person', studio: 'studio' };

    ctx.addStyle(
      'ala-keyframe-style',
      `
      #${ID}{flex:0 0 auto;margin-right:12px;text-decoration:none;color:inherit;cursor:pointer;white-space:nowrap}
      #${ID}.ala-kf-plain{display:inline-flex;align-items:center;gap:7px;min-height:30px;padding:0 12px;border-radius:4px;background:rgb(var(--color-foreground));font-size:1.2rem;font-weight:500;line-height:1;transition:background .15s,color .15s}
      #${ID}.ala-kf-plain:hover{background:rgb(var(--color-blue));color:#fff}
      #${ID} .icon{flex:0 0 auto}`
    );

    const copyScope = (from: Element, to: Element): void => {
      for (const at of Array.from(from.attributes)) {
        if (at.name.startsWith('data-v-')) to.setAttribute(at.name, at.value);
      }
    };

    function skin(a: HTMLElement | null, container?: Element | null): void {
      if (!a || a.dataset.kfSkin) return;
      const ref = (container ?? a.parentElement)?.querySelector('.mini-select');
      if (!ref) return;
      a.classList.remove('ala-kf-plain');
      a.classList.add('mini-select');
      copyScope(ref, a);

      const refIcon = ref.querySelector('svg');
      const refLabel = ref.querySelector('.label');
      const iconEl = a.querySelector('svg');
      const labelEl = a.querySelector('span');

      if (iconEl) {
        iconEl.classList.add('icon');
        if (refIcon) copyScope(refIcon, iconEl);
      }
      if (labelEl) {
        labelEl.classList.add('label');
        if (refLabel) copyScope(refLabel, labelEl);
      }
      a.dataset.kfSkin = '1';
    }

    ctx.onRoute(/^\/(staff|studio)\/(\d+)(?:\/|$)/, (rc) => {
      const kind = rc.match![1] as 'staff' | 'studio';
      const id = rc.match![2];

      rc.mount({
        id: ID,
        anchor: SLOT,
        position: 'afterbegin',
        create: () => {
          const a = document.createElement('a');
          a.id = ID;
          a.className = 'ala-kf-plain';
          a.href = `${BASE}/${PATHS[kind]}/${id}`;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.title = `Open on ${LABEL}`;
          a.setAttribute('aria-label', `Open on ${LABEL}`);
          a.innerHTML = `${icon('external', 14)}<span>${LABEL}</span>`;
          rc.listen(a, 'click', (e) => e.stopPropagation());
          skin(a, document.querySelector(SLOT));
          return a;
        }
      });

      rc.onCleanup(ctx.onBodyMutation(() => skin(document.getElementById(ID))));
    });
  }
});
