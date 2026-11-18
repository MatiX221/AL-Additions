import { Settings } from '../../settings/settings';
import { esc } from '../../utils/helpers';
import { DEFAULT_TIERS, validateTiers, normalizeHexColor, type TierConfig } from './tiers';

export function openTierEditor(inputEl: HTMLInputElement): void {
  let tiers: TierConfig[];
  try {
    const parsed = JSON.parse(inputEl.value);
    const check = validateTiers(parsed);
    tiers = check.valid && check.tiers ? check.tiers : JSON.parse(JSON.stringify(DEFAULT_TIERS));
  } catch {
    tiers = JSON.parse(JSON.stringify(DEFAULT_TIERS));
  }

  const existing = document.getElementById('ala-tier-editor-backdrop');
  if (existing) existing.remove();

  const backdrop = document.createElement('div');
  backdrop.id = 'ala-tier-editor-backdrop';
  backdrop.innerHTML = `
    <div class="ala-sheet ala-tier-editor-sheet" role="dialog" aria-modal="true" aria-labelledby="ala-tier-modal-title">
      <header class="ala-sheet-head">
        <h2 id="ala-tier-modal-title">Customize Tier Labels</h2>
        <button class="ala-icon-btn ala-tier-close" type="button" aria-label="Close">✕</button>
      </header>
      <div class="ala-sheet-body">
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
      </div>
      <footer class="ala-sheet-foot">
        <button class="ala-btn ala-btn--primary" id="ala-tier-btn-save" type="button">Apply Tiers</button>
        <button class="ala-btn" id="ala-tier-btn-cancel" type="button">Cancel</button>
        <span class="ala-tier-status" id="ala-tier-status" role="status"></span>
      </footer>
    </div>
  `;

  document.body.appendChild(backdrop);
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

  const closeModal = () => {
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeModal();
    }
  };
  document.addEventListener('keydown', onKey, true);

  backdrop.querySelector('.ala-tier-close')?.addEventListener('click', closeModal);
  backdrop.querySelector('#ala-tier-btn-cancel')?.addEventListener('click', closeModal);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal();
  });

  backdrop.querySelector('#ala-tier-btn-save')?.addEventListener('click', () => {
    const data = getRowsData();
    const check = validateTiers(data);
    if (!check.valid || !check.tiers) {
      setModalStatus(check.error || 'Invalid tier configuration.', true);
      return;
    }
    inputEl.value = JSON.stringify(check.tiers);
    Settings.set('tierLabels', check.tiers);
    closeModal();
    const panelStatus = document.querySelector('#ala-settings-panel .ala-status');
    if (panelStatus) {
      panelStatus.textContent = 'Custom tiers applied. Press "Save and reload" to activate.';
    }
  });

  renderTable(tiers);
}
