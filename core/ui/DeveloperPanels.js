// Shared shell and visibility management for developer-only slot tooling panels.
// Simulation and tuning remain modal-style panels; the live spin log is a floating tool window.

function makePanelMovable(panel, titlebar) {
  if (titlebar.dataset.movable === 'true') return;
  titlebar.dataset.movable = 'true';
  titlebar.classList.add('developer-panel-drag-handle');
  let drag = null;

  titlebar.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('button')) return;
    const rect = panel.getBoundingClientRect();
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.transform = 'none';
    drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    panel.classList.add('is-dragging');
    titlebar.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });

  titlebar.addEventListener('pointermove', event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const maxLeft = Math.max(8, window.innerWidth - panel.offsetWidth - 8);
    const maxTop = Math.max(8, window.innerHeight - panel.offsetHeight - 8);
    const left = Math.min(maxLeft, Math.max(8, drag.left + event.clientX - drag.x));
    const top = Math.min(maxTop, Math.max(8, drag.top + event.clientY - drag.y));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  });

  const stopDragging = event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    titlebar.releasePointerCapture?.(event.pointerId);
    drag = null;
    panel.classList.remove('is-dragging');
  };
  titlebar.addEventListener('pointerup', stopDragging);
  titlebar.addEventListener('pointercancel', stopDragging);
}

function makePanelCollapsible(panel, titlebar) {
  if (titlebar.dataset.collapsible === 'true') return;
  titlebar.dataset.collapsible = 'true';
  const collapseButton = document.createElement('button');
  collapseButton.type = 'button';
  collapseButton.className = 'developer-panel-collapse';
  collapseButton.title = 'Collapse panel';
  collapseButton.setAttribute('aria-label', 'Collapse panel');
  collapseButton.setAttribute('aria-expanded', 'true');
  collapseButton.textContent = '−';
  const setCollapsed = collapsed => {
    if (collapsed) {
      const rect = panel.getBoundingClientRect();
      panel.dataset.expandedWidth = `${Math.round(rect.width)}px`;
      panel.dataset.expandedHeight = `${Math.round(rect.height)}px`;
    }
    panel.classList.toggle('is-collapsed', collapsed);
    panel.dataset.collapsed = String(collapsed);
    if (!collapsed) {
      if (panel.dataset.expandedWidth) panel.style.width = panel.dataset.expandedWidth;
      if (panel.dataset.expandedHeight) panel.style.height = panel.dataset.expandedHeight;
    }
    collapseButton.textContent = collapsed ? '+' : '−';
    collapseButton.title = collapsed ? 'Expand panel' : 'Collapse panel';
    collapseButton.setAttribute('aria-label', collapseButton.title);
    collapseButton.setAttribute('aria-expanded', String(!collapsed));
  };
  collapseButton.addEventListener('pointerdown', event => event.stopPropagation());
  collapseButton.addEventListener('click', event => {
    event.stopPropagation();
    setCollapsed(!panel.classList.contains('is-collapsed'));
  });
  const closeButton = titlebar.querySelector('.developer-panel-close');
  titlebar.insertBefore(collapseButton, closeButton);
  setCollapsed(panel.dataset.collapsed === 'true');
}

function addPanelTitlebar(panel, title, { movable = false, collapsible = false } = {}) {
  let titlebar = Array.from(panel.children).find(child => child.classList?.contains('developer-panel-titlebar'));
  if (!titlebar) {
    const oldHeading = Array.from(panel.children).find(child => child.tagName === 'H2');
    const closeButton = Array.from(panel.children).find(child => child.classList?.contains('btn-modal-close'))
      || document.createElement('button');
    if (!closeButton.classList.contains('btn-modal-close')) {
      closeButton.className = 'btn-modal-close';
      closeButton.type = 'button';
      closeButton.setAttribute('aria-label', 'Close');
      closeButton.textContent = '×';
      panel.appendChild(closeButton);
    }

    titlebar = document.createElement('div');
    titlebar.className = 'developer-panel-titlebar';
    const heading = document.createElement('div');
    heading.className = 'developer-panel-heading';
    heading.innerHTML = `<span class="developer-panel-kicker">DEV TOOL</span><span class="developer-panel-title">${title}</span>`;
    closeButton.classList.add('developer-panel-close');
    if (!closeButton.dataset.panelCloseBound) {
      closeButton.addEventListener('click', () => hideDeveloperPanel(panel));
      closeButton.dataset.panelCloseBound = 'true';
    }
    if (oldHeading) oldHeading.remove();
    closeButton.remove();
    titlebar.append(heading, closeButton);
    panel.prepend(titlebar);
    const titleId = `${panel.id}-title`;
    heading.lastElementChild.id = titleId;
    panel.setAttribute('aria-labelledby', titleId);
  }

  if (movable) makePanelMovable(panel, titlebar);
  if (collapsible) makePanelCollapsible(panel, titlebar);
}

function createPanel(id, kind, title, options = {}) {
  const panel = document.createElement('div');
  panel.id = id;
  panel.className = 'sim-modal developer-panel';
  panel.dataset.developerPanel = kind;
  panel.style.display = 'none';
  panel.setAttribute('role', options.nonModal ? 'region' : 'dialog');
  panel.setAttribute('aria-label', title);
  document.body.appendChild(panel);
  addPanelTitlebar(panel, title, options);
  return panel;
}

function ensurePanel(id, kind, title, options = {}) {
  const existing = document.getElementById(id);
  if (existing) {
    existing.classList.add('developer-panel');
    existing.dataset.developerPanel = kind;
    existing.setAttribute('role', options.nonModal ? 'region' : 'dialog');
    existing.setAttribute('aria-label', title);
    addPanelTitlebar(existing, title, options);
    return existing;
  }
  return createPanel(id, kind, title, options);
}

export function ensureDeveloperPanels() {
  const simulation = ensurePanel('sim-modal', 'simulation', 'Simulation Results');
  const tuning = ensurePanel('tuning-modal', 'tuning', 'Frequency Tuning');
  const spinLog = ensurePanel('spinlog-modal', 'spinlog', 'Live Spin Log', { movable: true, collapsible: true, nonModal: true });
  return { simulation, tuning, spinLog };
}

export function showDeveloperPanel(panel) {
  if (!panel) return;
  const floating = panel.dataset.developerPanel === 'spinlog';
  if (!floating) {
    document.querySelectorAll('.developer-panel').forEach(other => {
      if (other !== panel) other.style.display = 'none';
    });
  }
  panel.style.display = floating ? 'flex' : 'block';
}

export function hideDeveloperPanel(panel) {
  if (!panel) return;
  panel.__spinLogAutoUpdate?.();
  panel.__spinLogAutoUpdate = null;
  panel.style.display = 'none';
}
