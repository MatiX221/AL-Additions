import { esc } from '../../utils/helpers';
import { DEFAULT_TIERS, validateTiers, normalizeHexColor, type TierConfig } from './tiers';
import type { JsonEditorContext } from '../../types';

const buildTierModalCss = (sel: string): string => `
  ${sel} .ala-tier-desc{font-size:13px;color:rgb(var(--color-text-lighter));margin:0 0 14px;line-height:1.4}
  ${sel} .ala-tier-table-wrap{overflow-x:auto;max-height:48vh;overflow-y:auto;border:1px solid rgba(var(--color-text-lighter),.15);border-radius:8px;padding:4px}
  ${sel} .ala-tier-table{width:100%;border-collapse:collapse;font-size:13px}
  ${sel} .ala-tier-table th{text-align:left;padding:8px 6px;color:rgb(var(--color-text-lighter));font-weight:600;border-bottom:1px solid rgba(var(--color-text-lighter),.15)}
  ${sel} .ala-tier-table td{padding:6px;vertical-align:middle;border-bottom:1px solid rgba(var(--color-text-lighter),.08)}
  ${sel} .ala-tier-table input[type=text],${sel} .ala-tier-table input[type=number]{height:34px;padding:0 8px;border-radius:6px;border:1px solid rgba(var(--color-text-lighter),.2);background:rgb(var(--color-background));color:rgb(var(--color-text));font:inherit;font-size:13px;box-sizing:border-box}
  ${sel} .ala-tier-table input[type=color]{width:36px;height:34px;padding:1px;border-radius:6px;border:1px solid rgba(var(--color-text-lighter),.2);background:transparent;cursor:pointer}
  ${sel} .ala-tier-del-btn{padding:0 8px;height:32px;min-width:32px;display:inline-flex;align-items:center;justify-content:center}
  ${sel} .ala-tier-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
  ${sel} .ala-tier-json-area{width:100%;height:100px;font-family:monospace;font-size:12px;border-radius:6px;border:1px solid rgba(var(--color-text-lighter),.2);background:rgb(var(--color-background));color:rgb(var(--color-text));padding:8px;box-sizing:border-box;resize:vertical}
  ${sel} .ala-tier-status{margin-left:auto;font-size:13px;color:rgb(var(--color-green,76,175,80))}
  ${sel} .ala-tier-status.is-error{color:rgb(var(--color-red,224,85,85))}
  ${sel} .ala-core-foot{justify-content:flex-start}
  @media (max-width:720px){
    ${sel}{align-items:flex-end;padding:0}
    ${sel} .ala-core-sheet{width:100%;max-height:92vh;max-height:92dvh;border-radius:14px 14px 0 0}
    ${sel} .ala-tier-table-wrap{max-height:45vh}
    ${sel} .ala-tier-table th,${sel} .ala-tier-table td{padding:4px}
  }
`;

export function openTierEditor(ctx: JsonEditorContext): void {
  const checkInit = validateTiers(ctx.value);
  const tiers: TierConfig[] =
    checkInit.valid && checkInit.tiers ? checkInit.tiers : JSON.parse(JSON.stringify(DEFAULT_TIERS));

  const modal = ctx.modal({
    id: 'tier-editor',
    title: 'Customize Tier Labels',
    maxWidth: '640px',
    bodyHtml: `
      <p class="ala-tier-desc">Configure tier badges, score thresholds (0–100 scale), and colors. Tiers match in order from top to bottom.</p>
      <div class="ala-tier-table-wrap">
        <table class="ala-tier-table">
          <thead>
            <tr>
              <th style="width:75px">Label</th>
              <th style="width:70px">Min</th>
              <th style="width:70px">Max</th>
              <th style="width:48px">Badge</th>
              <th style="width:48px">Text</th>
              <th style="width:75px">Preview</th>
              <th style="width:36px"></th>
            </tr>
          </thead>
          <tbody id="ala-tier-tbody"></tbody>
        </table>
      </div>
      <div class="ala-tier-actions">
        <button type="button" class="ala-btn" id="ala-tier-btn-add">+ Add Tier</button>
        <button type="button" class="ala-btn" id="ala-tier-btn-reset">Reset Defaults</button>
        <button type="button" class="ala-btn" id="ala-tier-btn-toggle-json">Import / Export JSON</button>
      </div>
      <div id="ala-tier-json-wrap" style="display:none;margin-top:12px">
        <textarea id="ala-tier-json-area" class="ala-tier-json-area" rows="6" spellcheck="false"></textarea>
        <div style="display:flex;gap:8px;margin-top:6px">
          <button type="button" class="ala-btn" id="ala-tier-btn-apply-json">Apply JSON</button>
        </div>
      </div>
    `,
    footerHtml: `
      <button class="ala-btn ala-btn--primary" id="ala-tier-btn-save" type="button">Apply Tiers</button>
      <button class="ala-btn" id="ala-tier-btn-cancel" type="button">Cancel</button>
      <span class="ala-tier-status" id="ala-tier-status" role="status"></span>
    `
  });
  ctx.addStyle('tier-modal', () => buildTierModalCss(`#${modal.backdrop.id}`));
  const { backdrop, close } = modal;
  const tbody = backdrop.querySelector('#ala-tier-tbody') as HTMLElement;
  const status = backdrop.querySelector('#ala-tier-status') as HTMLElement;

  const setModalStatus = (msg: string, isError = false) => {
    status.textContent = msg;
    status.className = `ala-tier-status ${isError ? 'is-error' : ''}`;
  };

  const createRowHtml = (t: TierConfig, idx: number) => {
    const badgeColor = normalizeHexColor(t.color) || '#000000';
    const textColor = normalizeHexColor(t.textColor) || '#ffffff';
    return `
    <tr data-idx="${idx}">
      <td><input type="text" class="ala-t-label" value="${esc(t.label)}" maxlength="20" placeholder="Label" style="width:100%"></td>
      <td><input type="number" class="ala-t-min" min="0" max="100" step="0.1" value="${t.min}" style="width:100%"></td>
      <td><input type="number" class="ala-t-max" min="0" max="100" step="0.1" value="${t.max}" style="width:100%"></td>
      <td><input type="color" class="ala-t-color" value="${esc(badgeColor)}" title="Badge Background Color"></td>
      <td><input type="color" class="ala-t-text-color" value="${esc(textColor)}" title="Badge Text Color"></td>
      <td><span class="ala-tier-badge ala-tier-badge--list ala-t-preview" style="background-color:${esc(badgeColor)};color:${esc(textColor)}">${esc(t.label)}</span></td>
      <td><button type="button" class="ala-icon-btn ala-tier-del-btn" title="Delete Tier">✕</button></td>
    </tr>
  `;
  };

  const renderTable = (list: TierConfig[]) => {
    tbody.innerHTML = list.map((t, i) => createRowHtml(t, i)).join('');
  };

  const getRowsData = (): TierConfig[] => {
    const rows = tbody.querySelectorAll<HTMLTableRowElement>('tr');
    const result: TierConfig[] = [];
    rows.forEach((tr) => {
      const label = (tr.querySelector<HTMLInputElement>('.ala-t-label')?.value || '').trim();
      const min = parseFloat(tr.querySelector<HTMLInputElement>('.ala-t-min')?.value || '0');
      const max = parseFloat(tr.querySelector<HTMLInputElement>('.ala-t-max')?.value || '100');
      const color = tr.querySelector<HTMLInputElement>('.ala-t-color')?.value || '#000000';
      const textColor = tr.querySelector<HTMLInputElement>('.ala-t-text-color')?.value || '#ffffff';
      result.push({
        label: label || 'Tier',
        min: isNaN(min) ? 0 : min,
        max: isNaN(max) ? 100 : max,
        color,
        textColor
      });
    });
    return result;
  };

  const updatePreview = (tr: HTMLTableRowElement) => {
    const label = tr.querySelector<HTMLInputElement>('.ala-t-label')?.value || '';
    const color = tr.querySelector<HTMLInputElement>('.ala-t-color')?.value || '#000000';
    const textColor = tr.querySelector<HTMLInputElement>('.ala-t-text-color')?.value || '#ffffff';
    const preview = tr.querySelector<HTMLElement>('.ala-t-preview');
    if (preview) {
      preview.textContent = label;
      preview.style.backgroundColor = color;
      preview.style.color = textColor;
    }
  };

  tbody.addEventListener('input', (e) => {
    const target = e.target as HTMLElement;
    const tr = target.closest<HTMLTableRowElement>('tr');
    if (tr) updatePreview(tr);
  });

  tbody.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const btn = target.closest<HTMLButtonElement>('.ala-tier-del-btn');
    if (btn) {
      const tr = btn.closest<HTMLTableRowElement>('tr');
      if (tr) {
        tr.remove();
        setModalStatus('Tier removed.');
      }
    }
  });

  backdrop.querySelector('#ala-tier-btn-add')?.addEventListener('click', () => {
    const current = getRowsData();
    current.push({ min: 0, max: 0, label: 'New', color: '#3db4f2', textColor: '#ffffff' });
    renderTable(current);
    setModalStatus('Added new tier.');
  });

  backdrop.querySelector('#ala-tier-btn-reset')?.addEventListener('click', () => {
    renderTable(JSON.parse(JSON.stringify(DEFAULT_TIERS)));
    setModalStatus('Reset to default tiers.');
  });

  const jsonWrap = backdrop.querySelector('#ala-tier-json-wrap') as HTMLElement;
  const jsonArea = backdrop.querySelector('#ala-tier-json-area') as HTMLTextAreaElement;

  backdrop.querySelector('#ala-tier-btn-toggle-json')?.addEventListener('click', () => {
    const isHidden = jsonWrap.style.display === 'none';
    if (isHidden) {
      jsonArea.value = JSON.stringify(getRowsData(), null, 2);
      jsonWrap.style.display = 'block';
    } else {
      jsonWrap.style.display = 'none';
    }
  });

  backdrop.querySelector('#ala-tier-btn-apply-json')?.addEventListener('click', () => {
    try {
      const parsed = JSON.parse(jsonArea.value);
      const check = validateTiers(parsed);
      if (!check.valid || !check.tiers) {
        setModalStatus(check.error || 'Invalid tier JSON.', true);
        return;
      }
      renderTable(check.tiers);
      jsonWrap.style.display = 'none';
      setModalStatus('JSON applied successfully.');
    } catch (e: any) {
      setModalStatus('Invalid JSON syntax: ' + (e.message || e), true);
    }
  });

  backdrop.querySelector('#ala-tier-btn-cancel')?.addEventListener('click', close);

  backdrop.querySelector('#ala-tier-btn-save')?.addEventListener('click', () => {
    const data = getRowsData();
    const check = validateTiers(data);
    if (!check.valid || !check.tiers) {
      setModalStatus(check.error || 'Invalid tier configuration.', true);
      return;
    }
    ctx.onApply(check.tiers);
    close();
  });

  renderTable(tiers);
}
