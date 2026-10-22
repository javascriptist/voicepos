// pos-web/public/app.js
// The Crown & Copper Web POS Interface
// Full client-side controller interacting with the Node.js API bridge

(function () {
  'use strict';

  // State
  const state = {
    posReady: false,
    posLoggedIn: false,
    activeView: 'tables',
    activeFilter: 'all',
    tableSearch: '',
    menuSearch: '',
    selectedCategory: 'all',
    
    tables: [],
    menuItems: [],
    categories: [],
    orderTypes: [],

    activeTableNumber: null,
    activeTicket: null,       // Persisted Ticket object from POS
    pendingLines: [],        // Unsaved item lines staged in current order
    
    // Customization modal temporary state
    customizingItem: null,
    customizingQty: 1,
    customizingSeat: 1,
    selectedModifiers: [],   // [{ groupId, modifierId, name, price, extraPrice, quantity, type }]
    customInstructions: [],

    kdsTickets: [],
    kdsAutoTimer: null
  };

  // DOM Elements
  const el = {
    posBadge: document.getElementById('pos-status-badge'),
    posBanner: document.getElementById('pos-banner'),
    bannerMessage: document.getElementById('banner-message'),
    bannerBtn: document.getElementById('banner-action-btn'),
    navBtns: document.querySelectorAll('.nav-btn'),
    views: {
      tables: document.getElementById('view-tables'),
      register: document.getElementById('view-register'),
      kds: document.getElementById('view-kds'),
      tickets: document.getElementById('view-tickets'),
      voice: document.getElementById('view-voice')
    },
    tablesGrid: document.getElementById('tables-grid'),
    tableSearch: document.getElementById('table-search-input'),
    filterChips: document.querySelectorAll('.filter-chips .chip'),
    openTabsCount: document.getElementById('open-tabs-count'),
    activeTablePill: document.getElementById('active-table-pill'),
    kdsPendingCount: document.getElementById('kds-pending-count'),

    // Register / Catalog
    menuGrid: document.getElementById('menu-items-grid'),
    categoryPills: document.getElementById('category-pills'),
    menuSearch: document.getElementById('menu-search-input'),
    btnClearSearch: document.getElementById('btn-clear-search'),

    // Ticket / Cart
    cartTableTitle: document.getElementById('cart-table-title'),
    cartOrderType: document.getElementById('cart-order-type'),
    cartTicketMeta: document.getElementById('cart-ticket-meta'),
    cartItemsList: document.getElementById('cart-items-list'),
    btnSwitchTable: document.getElementById('btn-switch-table'),
    btnRefreshTab: document.getElementById('btn-refresh-tab'),
    summarySubtotal: document.getElementById('summary-subtotal'),
    summaryTax: document.getElementById('summary-tax'),
    summaryTotal: document.getElementById('summary-total'),
    btnAddItems: document.getElementById('btn-add-items'),
    btnSendKitchen: document.getElementById('btn-send-kitchen'),
    quickInstChips: document.querySelectorAll('.inst-chip[data-inst]'),
    btnCustomInst: document.getElementById('btn-custom-instruction'),

    // Modals
    modalOpenTab: document.getElementById('modal-open-tab'),
    modalOpenTabTitle: document.getElementById('modal-open-tab-title'),
    inputOrderType: document.getElementById('input-order-type'),
    btnGuestMinus: document.getElementById('btn-guest-minus'),
    btnGuestPlus: document.getElementById('btn-guest-plus'),
    guestCountVal: document.getElementById('guest-count-val'),
    btnConfirmOpenTab: document.getElementById('btn-confirm-open-tab'),

    modalCustomize: document.getElementById('modal-item-customize'),
    modalItemName: document.getElementById('modal-item-name'),
    modalItemPrice: document.getElementById('modal-item-price'),
    modalItemTotal: document.getElementById('modal-item-total'),
    modifierGroupsContainer: document.getElementById('modifier-groups-container'),
    modalInstInput: document.getElementById('modal-inst-input'),
    btnModalAddInst: document.getElementById('btn-modal-add-inst'),
    modalInstTags: document.getElementById('modal-inst-tags'),
    btnModalQtyMinus: document.getElementById('btn-modal-qty-minus'),
    btnModalQtyPlus: document.getElementById('btn-modal-qty-plus'),
    modalQtyVal: document.getElementById('modal-qty-val'),
    btnModalAddToOrder: document.getElementById('btn-modal-add-to-order'),
    seatPills: document.getElementById('seat-pills'),

    modalCustomInst: document.getElementById('modal-custom-inst'),
    inputCustomInst: document.getElementById('input-custom-instruction'),
    btnConfirmCustomInst: document.getElementById('btn-confirm-custom-inst'),

    // KDS
    kdsBoard: document.getElementById('kds-board'),
    btnRefreshKds: document.getElementById('btn-refresh-kds'),

    // Tickets
    openTicketsList: document.getElementById('open-tickets-list'),
    ticketDetailPanel: document.getElementById('ticket-detail-panel'),
    ticketLookupId: document.getElementById('ticket-lookup-id'),
    btnLookupTicket: document.getElementById('btn-lookup-ticket'),
    btnRefreshOpenTickets: document.getElementById('btn-refresh-open-tickets'),

    toastContainer: document.getElementById('toast-container'),
    btnQuickNewTab: document.getElementById('btn-quick-new-tab'),

    // Voice Playground Elements
    voiceForm: document.getElementById('voice-command-form'),
    voiceTextInput: document.getElementById('voice-text-input'),
    btnToggleMic: document.getElementById('btn-toggle-mic'),
    micStatusPill: document.getElementById('mic-status-pill'),
    micLabel: document.getElementById('mic-label'),
    voiceTranscriptBox: document.getElementById('voice-transcript-box'),
    lastToolBadge: document.getElementById('last-tool-badge'),
    lastToolJson: document.getElementById('last-tool-json'),
    btnRejoinAgora: document.getElementById('btn-rejoin-agora'),
    btnToggleTts: document.getElementById('btn-toggle-tts'),
    callBar: document.getElementById('call-bar'),
    callTimer: document.getElementById('call-timer'),
    btnCallMute: document.getElementById('btn-call-mute'),
    btnCallEnd: document.getElementById('btn-call-end'),
    agentStatusLabel: document.getElementById('agent-status-label'),
    activeAgentId: document.getElementById('active-agent-id'),
    presetVoiceChips: document.querySelectorAll('.preset-chip')
  };

  // Utility: Money Formatter (£ GBP)
  function formatMoney(amount) {
    const val = Number(amount) || 0;
    return '£' + val.toFixed(2);
  }

  // Escape text before putting it in an HTML template (menu names, notes, error messages).
  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Inline SVG icons (Lucide, ISC licence)
  const ICONS = {
    grid: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
    receipt: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 17.5v-11"/>',
    chef: '<path d="M17 21a1 1 0 0 0 1-1v-5.35c0-.457.316-.844.727-1.041a4 4 0 0 0-2.134-7.589 5 5 0 0 0-9.186 0 4 4 0 0 0-2.134 7.588c.411.198.727.585.727 1.041V20a1 1 0 0 0 1 1Z"/><path d="M6 17h12"/>',
    list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
    mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>',
    'mic-off': '<path d="M2 2l20 20"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><path d="M12 19v3"/>',
    phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
    'phone-off': '<path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/><path d="M22 2 2 22"/>',
    volume: '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
    'volume-off': '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    utensils: '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>'
  };

  function icon(name) {
    return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  }

  // Replace <i data-icon="name"> placeholders in static markup.
  function hydrateIcons(root = document) {
    root.querySelectorAll('i[data-icon]').forEach(node => {
      node.outerHTML = icon(node.dataset.icon);
    });
  }

  // POS category names are stored in capitals ("PUB CLASSICS"); show them in sentence case.
  function displayName(name) {
    const text = String(name || '');
    return text === text.toUpperCase() ? text.charAt(0) + text.slice(1).toLowerCase() : text;
  }

  function emptyState(iconName, title, text = '') {
    return `
      <div class="empty-cart-state" style="grid-column: 1 / -1;">
        <div class="empty-icon">${icon(iconName)}</div>
        <div class="empty-title">${esc(title)}</div>
        ${text ? `<p class="empty-text">${esc(text)}</p>` : ''}
      </div>
    `;
  }

  // Theme: follows the system until the user picks one.
  function currentTheme() {
    const forced = document.documentElement.dataset.theme;
    if (forced) return forced;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function renderThemeButton() {
    const btn = document.getElementById('btn-theme');
    if (!btn) return;
    const dark = currentTheme() === 'dark';
    btn.innerHTML = icon(dark ? 'sun' : 'moon');
    btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    btn.title = btn.getAttribute('aria-label');
  }

  function toggleTheme() {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('pos-theme', next);
    } catch (e) {}
    renderThemeButton();
  }

  // Toast Notifications
  function showToast(message, type = 'info', iconOverride = null) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type} entering`;
    
    const iconName = iconOverride || (type === 'success' ? 'check' : type === 'error' ? 'alert' : 'info');
    toast.innerHTML = `<span class="toast-icon">${icon(iconName)}</span><span class="toast-message"></span>`;
    toast.querySelector('.toast-message').textContent = message;
    
    el.toastContainer.appendChild(toast);
    
    // Snappy entrance
    requestAnimationFrame(() => {
      toast.classList.remove('entering');
    });

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      setTimeout(() => toast.remove(), 220);
    }, 3800);
  }

  // API Call Wrapper
  async function api(path, options = {}, maybeBody = null) {
    // Support api(path, 'POST', body) shorthand as well as api(path, options)
    if (typeof options === 'string') {
      const method = options.toUpperCase();
      options = { method };
      if (maybeBody !== null && maybeBody !== undefined) {
        options.body = maybeBody;
      }
    }

    const defaultHeaders = {
      'Accept': 'application/json'
    };
    if (options.body && typeof options.body === 'object') {
      defaultHeaders['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }
    options.headers = Object.assign(defaultHeaders, options.headers || {});
    
    try {
      const res = await fetch(path, options);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const errMessage = (typeof data.error === 'string' ? data.error : data.error && data.error.message) || data.message || `Request failed (${res.status})`;
        const err = new Error(errMessage);
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return data;
    } catch (err) {
      console.warn(`API error on ${path}:`, err);
      throw err;
    }
  }

  // ----------------------------------------------------
  // 1. Health & Status
  // ----------------------------------------------------
  async function checkHealth() {
    try {
      const res = await api('/api/health');
      if (res.status === 'ready' && res.loggedIn) {
        state.posReady = true;
        state.posLoggedIn = true;
        el.posBadge.className = 'status-badge status-ready';
        el.posBadge.innerHTML = '<span class="status-dot"></span><span class="status-label">POS ready</span>';
        el.posBanner.classList.add('hidden');
      } else if (res.status === 'not_ready' || !res.loggedIn) {
        state.posReady = false;
        state.posLoggedIn = false;
        el.posBadge.className = 'status-badge status-checking';
        el.posBadge.innerHTML = '<span class="status-dot"></span><span class="status-label">Not logged in</span>';
        el.posBanner.classList.remove('hidden');
        el.bannerMessage.textContent = 'Nobody is logged in on the till. Log in with an active shift to start taking orders.';
      } else {
        throw new Error('POS unexpected status');
      }
    } catch (err) {
      state.posReady = false;
      state.posLoggedIn = false;
      el.posBadge.className = 'status-badge status-offline';
      el.posBadge.innerHTML = '<span class="status-dot"></span><span class="status-label">POS offline</span>';
      el.posBanner.classList.remove('hidden');
      el.bannerMessage.textContent = 'Can\'t reach the POS. Start it with sh api-bridge/run.sh, then retry.';
    }
  }

  // ----------------------------------------------------
  // 2. Navigation & Views
  // ----------------------------------------------------
  function switchView(viewName) {
    if (!el.views[viewName]) viewName = 'tables';
    state.activeView = viewName;
    // Keep the view in the URL so a reload or a bookmark returns to it.
    if (location.hash !== `#${viewName}`) history.replaceState(null, '', `#${viewName}`);
    el.navBtns.forEach(btn => {
      if (btn.dataset.view === viewName) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    Object.keys(el.views).forEach(k => {
      if (k === viewName) {
        el.views[k].classList.add('active');
      } else {
        el.views[k].classList.remove('active');
      }
    });

    if (viewName === 'tables') {
      loadTables();
    } else if (viewName === 'register') {
      renderRegisterView();
    } else if (viewName === 'kds') {
      loadKds();
    } else if (viewName === 'tickets') {
      loadOpenTickets();
    }
  }

  // ----------------------------------------------------
  // 3. Tables Management
  // ----------------------------------------------------
  async function loadTables() {
    try {
      const data = await api('/api/tables');
      state.tables = data.tables || [];
      renderTables();
    } catch (err) {
      el.tablesGrid.innerHTML = emptyState('alert', 'Can\'t load tables', err.message);
    }
  }

  function renderTables() {
    const filter = state.activeFilter;
    const search = state.tableSearch.trim().toLowerCase();

    let freeCount = 0;
    let occupiedCount = 0;
    let dirtyCount = 0;

    state.tables.forEach(t => {
      const hasOpenTicket = t.openTicketIds && t.openTicketIds.length > 0;
      if (hasOpenTicket || !t.free) occupiedCount++;
      else if (t.dirty) dirtyCount++;
      else freeCount++;
    });

    document.getElementById('count-all').textContent = state.tables.length;
    document.getElementById('count-free').textContent = freeCount;
    document.getElementById('count-occupied').textContent = occupiedCount;
    document.getElementById('count-dirty').textContent = dirtyCount;
    el.openTabsCount.textContent = occupiedCount;

    const filtered = state.tables.filter(t => {
      const hasOpenTicket = t.openTicketIds && t.openTicketIds.length > 0;
      const isOccupied = hasOpenTicket || !t.free;

      if (filter === 'free' && isOccupied) return false;
      if (filter === 'occupied' && !isOccupied) return false;
      if (filter === 'dirty' && !t.dirty) return false;

      if (search && !String(t.number).includes(search)) return false;
      return true;
    });

    if (filtered.length === 0) {
      el.tablesGrid.innerHTML = emptyState('search', 'No tables match');
      return;
    }

    el.tablesGrid.innerHTML = '';
    filtered.forEach((table, idx) => {
      const hasOpenTicket = table.openTicketIds && table.openTicketIds.length > 0;
      const isOccupied = hasOpenTicket || !table.free;
      const isSelected = state.activeTableNumber === table.number;

      let statusClass = 'status-free';
      let statusText = 'Free';
      if (isOccupied) {
        statusClass = 'status-occupied';
        statusText = 'Occupied';
      } else if (table.dirty) {
        statusClass = 'status-dirty';
        statusText = 'Dirty';
      }

      const card = document.createElement('div');
      card.className = `table-card ${statusClass} ${isSelected ? 'selected-active' : ''}`;
      card.setAttribute('role', 'button');
      card.tabIndex = 0;
      card.setAttribute('aria-label', `Table ${table.number}, ${statusText}`);
      card.innerHTML = `
        <div class="table-card-top">
          <span class="table-number">${table.number}</span>
          ${statusClass === 'status-free' ? '' : `<span class="table-status-pill ${statusText.toLowerCase()}">${statusText}</span>`}
        </div>
        <div class="table-card-bottom">
          ${hasOpenTicket ? `<span class="table-tab-badge">Tab #${table.openTicketIds[0]}</span>` : `<span class="table-action-hint">${table.dirty ? 'Needs clearing' : (isOccupied ? 'Another server' : 'Free')}</span>`}
        </div>
      `;
      card.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleTableClick(table, isOccupied);
        }
      });

      card.addEventListener('click', () => {
        handleTableClick(table, isOccupied);
      });

      el.tablesGrid.appendChild(card);
    });
  }

  async function handleTableClick(table, isOccupied) {
    if (isOccupied && table.openTicketIds && table.openTicketIds.length > 0) {
      // Direct load open tab
      const ticketId = table.openTicketIds[0];
      await loadTicket(ticketId, table.number);
      switchView('register');
    } else {
      // Prompt open tab modal
      openTabModalForTable(table.number);
    }
  }

  function openTabModalForTable(tableNumber) {
    state.activeTableNumber = tableNumber;
    el.modalOpenTabTitle.textContent = `Open table ${tableNumber}`;
    el.guestCountVal.textContent = '2';
    el.modalOpenTab.classList.remove('hidden');
  }

  // ----------------------------------------------------
  // 4. Tab & Ticket Actions
  // ----------------------------------------------------
  async function confirmOpenTab() {
    const tableNumber = state.activeTableNumber;
    const orderTypeId = parseInt(el.inputOrderType.value, 10) || 1;
    const guestCount = parseInt(el.guestCountVal.textContent, 10) || 2;

    el.btnConfirmOpenTab.disabled = true;
    el.btnConfirmOpenTab.textContent = 'Opening...';

    try {
      const res = await api(`/api/tables/${tableNumber}/tab`, {
        method: 'POST',
        body: { orderTypeId, guestCount }
      });

      state.activeTicket = res.ticket;
      state.pendingLines = [];
      closeModal(el.modalOpenTab);
      showToast(`Tab #${res.ticket.id} opened for Table ${tableNumber}`, 'success');
      switchView('register');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      el.btnConfirmOpenTab.disabled = false;
      el.btnConfirmOpenTab.textContent = 'Open tab';
    }
  }

  async function loadTicket(ticketId, tableNumber = null) {
    try {
      const res = await api(`/api/tickets/${ticketId}`);
      state.activeTicket = res.ticket;
      if (tableNumber) {
        state.activeTableNumber = tableNumber;
      } else if (res.ticket.tableNumbers && res.ticket.tableNumbers.length > 0) {
        state.activeTableNumber = res.ticket.tableNumbers[0];
      }
      state.pendingLines = [];
      renderRegisterView();
    } catch (err) {
      showToast(`Failed to load tab #${ticketId}: ${err.message}`, 'error');
    }
  }

  // ----------------------------------------------------
  // 5. Menu & Catalog Management
  // ----------------------------------------------------
  async function loadMenu() {
    try {
      const data = await api('/api/menu');
      state.menuItems = (data.items || []).filter(item => item.supported);
      
      // Extract unique categories and groups
      const catMap = new Map();
      state.menuItems.forEach(item => {
        const cat = item.categoryName || 'Mains';
        const grp = item.groupName || 'Pub Classics';
        if (!catMap.has(cat)) catMap.set(cat, new Set());
        catMap.get(cat).add(grp);
      });

      state.categories = Array.from(catMap.keys());
      renderCategoryPills();
      renderMenu();
    } catch (err) {
      el.menuGrid.innerHTML = emptyState('alert', 'Can\'t load the menu', err.message);
    }
  }

  function renderCategoryPills() {
    el.categoryPills.innerHTML = '';
    
    // "All" pill
    const allBtn = document.createElement('button');
    allBtn.className = `cat-pill ${state.selectedCategory === 'all' ? 'active' : ''}`;
    allBtn.textContent = 'All';
    allBtn.addEventListener('click', () => {
      state.selectedCategory = 'all';
      renderCategoryPills();
      renderMenu();
    });
    el.categoryPills.appendChild(allBtn);

    state.categories.forEach(cat => {
      const btn = document.createElement('button');
      btn.className = `cat-pill ${state.selectedCategory === cat ? 'active' : ''}`;
      btn.textContent = displayName(cat);
      btn.addEventListener('click', () => {
        state.selectedCategory = cat;
        renderCategoryPills();
        renderMenu();
      });
      el.categoryPills.appendChild(btn);
    });
  }

  function renderMenu() {
    const search = state.menuSearch.trim().toLowerCase();
    const cat = state.selectedCategory;

    const filtered = state.menuItems.filter(item => {
      if (cat !== 'all' && item.categoryName !== cat) return false;
      if (search && !item.name.toLowerCase().includes(search)) return false;
      return true;
    });

    if (filtered.length === 0) {
      el.menuGrid.innerHTML = emptyState('search', 'Nothing matches that search');
      return;
    }

    el.menuGrid.innerHTML = '';
    filtered.forEach((item, idx) => {
      const card = document.createElement('div');
      card.className = 'menu-item-card';
      card.setAttribute('role', 'button');
      card.tabIndex = 0;
      if (item.description) card.title = item.description;
      card.innerHTML = `
        <div class="menu-item-top">
          <span class="menu-item-group">${esc(displayName(item.groupName || item.categoryName || ''))}</span>
          <h4 class="menu-item-title">${esc(item.name)}</h4>
        </div>
        <div class="menu-item-bottom">
          <span class="menu-item-price">${formatMoney(item.price)}</span>
          <div class="menu-item-tags">
            ${item.hasModifiers ? `<span class="item-badge">Options</span>` : ''}
            ${item.fractionalQuantity ? `<span class="item-badge">By weight</span>` : ''}
          </div>
        </div>
      `;
      card.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleMenuItemClick(item);
        }
      });

      card.addEventListener('click', () => {
        handleMenuItemClick(item);
      });

      el.menuGrid.appendChild(card);
    });
  }

  async function handleMenuItemClick(item) {
    if (!state.activeTicket) {
      showToast('Pick a table first', 'info');
      switchView('tables');
      return;
    }

    if (item.hasModifiers) {
      await openCustomizationModal(item);
    } else {
      // Direct add
      addSimpleLineToCart(item);
    }
  }

  function addSimpleLineToCart(item) {
    const existingIndex = state.pendingLines.findIndex(
      l => l.menuItemId === item.id && (!l.modifiers || l.modifiers.length === 0) && (!l.instructions || l.instructions.length === 0)
    );

    if (existingIndex >= 0) {
      state.pendingLines[existingIndex].quantity += 1;
    } else {
      state.pendingLines.push({
        menuItemId: item.id,
        name: item.name,
        quantity: 1,
        unitPrice: item.price,
        seatNumber: 1,
        modifiers: [],
        instructions: []
      });
    }

    renderTicketPanel();
  }

  // ----------------------------------------------------
  // 6. Customization & Modifiers Modal
  // ----------------------------------------------------
  async function openCustomizationModal(item) {
    state.customizingItem = item;
    state.customizingQty = 1;
    state.customizingSeat = 1;
    state.selectedModifiers = [];
    state.modifierGroups = [];
    state.customInstructions = [];

    el.modalItemName.textContent = item.name;
    el.modalItemPrice.textContent = formatMoney(item.price);
    el.modalQtyVal.textContent = '1';
    el.modalInstInput.value = '';
    renderModalInstructions();

    // Populate seats up to guest count
    const guests = (state.activeTicket && state.activeTicket.guestCount) || 4;
    el.seatPills.innerHTML = '';
    for (let s = 1; s <= Math.min(guests, 8); s++) {
      const pill = document.createElement('button');
      pill.className = `chip seat-pill ${s === 1 ? 'active' : ''}`;
      pill.type = 'button';
      pill.textContent = String(s);
      pill.setAttribute('aria-label', `Seat ${s}`);
      pill.addEventListener('click', () => {
        el.seatPills.querySelectorAll('.seat-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        state.customizingSeat = s;
      });
      el.seatPills.appendChild(pill);
    }

    // Load modifier groups
    el.modifierGroupsContainer.innerHTML = '<div class="loading-spinner">Loading options...</div>';
    el.btnModalAddToOrder.disabled = false;
    el.modalCustomize.classList.remove('hidden');

    try {
      const itemDetail = await api(`/api/menu/${item.id}`);
      renderModifierGroups(itemDetail.modifierGroups || []);
      updateModalTotal();
    } catch (err) {
      el.modifierGroupsContainer.innerHTML = `<div class="empty-text">Failed to load options: ${err.message}</div>`;
    }
  }

  // Options are full-width rows: the whole row is the tap target, the selected row is highlighted
  // with a check on the right. Single-choice groups behave like radios. No native checkbox boxes.
  function renderModifierGroups(groups) {
    el.modifierGroupsContainer.innerHTML = '';
    state.modifierGroups = groups;
    if (groups.length === 0) return;

    groups.forEach(group => {
      const min = group.minQuantity || 0;
      const max = group.maxQuantity || 0;
      const single = max === 1 || group.exclusive;
      let ruleText = 'Optional';
      if (min > 0 && single) ruleText = 'Required';
      else if (min > 0) ruleText = max > min ? `Choose ${min}–${max}` : `Choose ${min}`;
      else if (max > 1) ruleText = `Up to ${max}`;

      const block = document.createElement('fieldset');
      block.className = 'modifier-group-block';
      block.innerHTML = `
        <legend class="mod-group-title">
          <span>${esc(group.name)}</span>
          <span class="mod-group-rule ${min > 0 ? 'required' : ''}">${ruleText}</span>
        </legend>
        <div class="mod-options-list" role="${single ? 'radiogroup' : 'group'}"></div>
      `;
      const list = block.querySelector('.mod-options-list');

      (group.modifiers || []).forEach(mod => {
        const orderTypeId = (state.activeTicket && state.activeTicket.orderTypeId) || 1;
        const priceObj = (mod.prices || []).find(p => p.orderTypeId === orderTypeId) || (mod.prices && mod.prices[0]) || { normal: 0 };
        const normalPrice = Number(priceObj.normal) || 0;

        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'mod-option-row';
        row.setAttribute('role', single ? 'radio' : 'checkbox');
        row.setAttribute('aria-checked', 'false');
        row.innerHTML = `
          <span class="mod-option-label">${esc(mod.name)}</span>
          ${normalPrice > 0 ? `<span class="mod-option-price">+${formatMoney(normalPrice)}</span>` : ''}
          <span class="mod-option-check" aria-hidden="true">${icon('check')}</span>
        `;

        row.addEventListener('click', () => {
          const isSelected = row.getAttribute('aria-checked') === 'true';
          const inGroup = state.selectedModifiers.filter(m => m.groupId === group.id);
          if (isSelected) {
            // A required single choice can be changed but not cleared.
            if (single && min > 0) return;
            state.selectedModifiers = state.selectedModifiers.filter(m => !(m.groupId === group.id && m.modifierId === mod.id));
            row.setAttribute('aria-checked', 'false');
          } else {
            if (single) {
              state.selectedModifiers = state.selectedModifiers.filter(m => m.groupId !== group.id);
              list.querySelectorAll('.mod-option-row').forEach(r => r.setAttribute('aria-checked', 'false'));
            } else if (max > 0 && inGroup.length >= max) {
              showToast(`Up to ${max} for ${group.name}`, 'info');
              return;
            }
            state.selectedModifiers.push({ groupId: group.id, modifierId: mod.id, name: mod.name, price: normalPrice, quantity: 1, type: 'normal' });
            row.setAttribute('aria-checked', 'true');
          }
          updateModalTotal();
        });

        list.appendChild(row);
      });

      el.modifierGroupsContainer.appendChild(block);
    });
  }

  // Name of the first required group that isn't satisfied yet, or null.
  function missingRequiredChoice() {
    const groups = state.modifierGroups || [];
    const missing = groups.find(g => (g.minQuantity || 0) > state.selectedModifiers.filter(m => m.groupId === g.id).length);
    return missing ? missing.name : null;
  }

  function updateModalTotal() {
    const base = state.customizingItem ? state.customizingItem.price : 0;
    const mods = state.selectedModifiers.reduce((acc, m) => acc + (m.price * m.quantity), 0);
    const total = (base + mods) * state.customizingQty;
    el.modalItemTotal.textContent = formatMoney(total);
    const missing = missingRequiredChoice();
    el.btnModalAddToOrder.disabled = Boolean(missing);
    el.btnModalAddToOrder.title = missing ? `Choose ${missing.toLowerCase()} first` : '';
  }

  function renderModalInstructions() {
    el.modalInstTags.innerHTML = '';
    state.customInstructions.forEach((inst, idx) => {
      const tag = document.createElement('span');
      tag.className = 'inst-tag';
      tag.innerHTML = `
        <span>${esc(inst)}</span>
        <button type="button" class="inst-tag-del" aria-label="Remove note">${icon('x')}</button>
      `;
      tag.querySelector('.inst-tag-del').addEventListener('click', () => {
        state.customInstructions.splice(idx, 1);
        renderModalInstructions();
      });
      el.modalInstTags.appendChild(tag);
    });
  }

  function addModalCustomizedItem() {
    if (!state.customizingItem) return;

    state.pendingLines.push({
      menuItemId: state.customizingItem.id,
      name: state.customizingItem.name,
      quantity: state.customizingQty,
      unitPrice: state.customizingItem.price,
      seatNumber: state.customizingSeat,
      modifiers: state.selectedModifiers.map(m => ({
        groupId: m.groupId,
        modifierId: m.modifierId,
        quantity: m.quantity,
        type: m.type
      })),
      instructions: [...state.customInstructions]
    });

    closeModal(el.modalCustomize);
    renderTicketPanel();

  }

  // ----------------------------------------------------
  // 7. Ticket & Cart Rendering
  // ----------------------------------------------------
  function renderRegisterView() {
    if (!state.activeTicket) {
      el.activeTablePill.classList.add('hidden');
      el.cartTableTitle.textContent = 'No table';
      el.cartOrderType.textContent = 'Dine in';
      el.cartTicketMeta.textContent = 'Choose a table to start';
      el.cartItemsList.innerHTML = `
        <div class="empty-cart-state">
          <div class="empty-icon">${icon('grid')}</div>
          <div class="empty-title">No table selected</div>
          <p class="empty-text">Open a table or pick one with a tab to take an order.</p>
          <button class="btn btn-secondary btn-sm" style="margin-top: 12px;" id="btn-cart-choose-table">Go to tables</button>
        </div>
      `;
      document.getElementById('btn-cart-choose-table')?.addEventListener('click', () => switchView('tables'));
      el.summarySubtotal.textContent = '£0.00';
      el.summaryTax.textContent = '£0.00';
      el.summaryTotal.textContent = '£0.00';
      el.btnSendKitchen.disabled = true;
      el.btnAddItems.classList.add('hidden');
      return;
    }

    const t = state.activeTicket;
    const tableNum = state.activeTableNumber || (t.tableNumbers && t.tableNumbers[0]) || '?';
    
    el.activeTablePill.classList.remove('hidden');
    el.activeTablePill.textContent = `T${tableNum}`;
    el.cartTableTitle.textContent = `Table ${tableNum}`;
    el.cartOrderType.textContent = t.orderTypeId === 1 ? 'Dine in' : (t.orderTypeId === 2 ? 'Takeaway' : 'Bar tab');
    el.cartTicketMeta.textContent = `Tab #${t.id} · ${t.guestCount || 1} ${t.guestCount === 1 ? 'guest' : 'guests'}`;

    renderTicketPanel();
  }

  function renderTicketPanel() {
    const t = state.activeTicket;
    if (!t) return;

    el.cartItemsList.innerHTML = '';
    const persistedItems = t.items || [];
    const hasAnyItems = persistedItems.length > 0 || state.pendingLines.length > 0;

    if (!hasAnyItems) {
      el.cartItemsList.innerHTML = `
        <div class="empty-cart-state">
          <div class="empty-icon">${icon('utensils')}</div>
          <div class="empty-title">Nothing ordered yet</div>
          <p class="empty-text">Tap items on the menu to add them.</p>
        </div>
      `;
    }

    // 1. Render already persisted items
    persistedItems.forEach(item => {
      const line = document.createElement('div');
      const isSent = item.sentToKitchen;
      line.className = `cart-line-item ${isSent ? 'sent-kitchen' : 'pending-send'}`;

      let modifiersHtml = '';
      if (item.modifiers && item.modifiers.length > 0) {
        modifiersHtml = `
          <div class="cart-line-modifiers">
            ${item.modifiers.map(m => `+ ${esc(m.name)}${m.modifierType === 'extra' ? ' (extra)' : ''}`).join('<br>')}
          </div>
        `;
      }

      let instructionsHtml = '';
      if (item.instructions && item.instructions.length > 0) {
        instructionsHtml = `
          <div class="cart-line-instructions">
            ${icon('alert')}<span>${esc(item.instructions.join(', '))}</span>
          </div>
        `;
      }

      line.innerHTML = `
        <div class="cart-line-top">
          <span class="cart-line-title">
            <span>${item.quantity}×</span>
            <span>${esc(item.name)}</span>
          </span>
          <span class="cart-line-price">${formatMoney(item.total)}</span>
        </div>
        <div class="cart-line-meta">
          ${item.seatNumber ? `<span class="line-seat-pill">Seat ${item.seatNumber}</span>` : ''}
          ${item.kitchenEligible === false ? '<span class="line-status-pill">Bar</span>' : `<span class="line-status-pill ${isSent ? 'sent' : 'ready'}">${isSent ? 'Sent' : 'Not sent'}</span>`}
        </div>
        ${modifiersHtml}
        ${instructionsHtml}
      `;
      el.cartItemsList.appendChild(line);
    });

    // 2. Render newly added pending items
    state.pendingLines.forEach((pending, idx) => {
      const line = document.createElement('div');
      line.className = 'cart-line-item pending-send';

      let instructionsHtml = '';
      if (pending.instructions && pending.instructions.length > 0) {
        instructionsHtml = `
          <div class="cart-line-instructions">
            ${icon('alert')}<span>${esc(pending.instructions.join(', '))}</span>
          </div>
        `;
      }

      const lineTotal = pending.unitPrice * pending.quantity;

      line.innerHTML = `
        <div class="cart-line-top">
          <span class="cart-line-title">
            <span>${pending.quantity}×</span>
            <span>${esc(pending.name)}</span>
          </span>
          <span class="cart-line-price">${formatMoney(lineTotal)}</span>
        </div>
        <div class="cart-line-meta">
          <span class="line-seat-pill">Seat ${pending.seatNumber}</span>
          <span class="line-status-pill">Unsaved</span>
        </div>
        ${instructionsHtml}
        <div class="cart-line-controls">
          <div class="stepper stepper-sm">
            <button class="stepper-btn btn-line-minus" aria-label="Decrease">−</button>
            <span class="stepper-val">${pending.quantity}</span>
            <button class="stepper-btn btn-line-plus" aria-label="Increase">+</button>
          </div>
          <button class="btn btn-ghost btn-sm btn-line-del">Remove</button>
        </div>
      `;

      line.querySelector('.btn-line-minus').addEventListener('click', () => {
        if (pending.quantity > 1) {
          pending.quantity--;
        } else {
          state.pendingLines.splice(idx, 1);
        }
        renderTicketPanel();
      });

      line.querySelector('.btn-line-plus').addEventListener('click', () => {
        pending.quantity++;
        renderTicketPanel();
      });

      line.querySelector('.btn-line-del').addEventListener('click', () => {
        state.pendingLines.splice(idx, 1);
        renderTicketPanel();
      });

      el.cartItemsList.appendChild(line);
    });

    // Totals calculation
    let currentTotal = Number(t.total) || 0;
    let pendingTotal = state.pendingLines.reduce((acc, l) => acc + (l.unitPrice * l.quantity), 0);
    let combinedTotal = currentTotal + pendingTotal;
    let combinedSubtotal = combinedTotal / 1.20; // 20% VAT inclusive
    let combinedTax = combinedTotal - combinedSubtotal;

    el.summarySubtotal.textContent = formatMoney(combinedSubtotal);
    el.summaryTax.textContent = formatMoney(combinedTax);
    el.summaryTotal.textContent = formatMoney(combinedTotal);

    // Button states
    const hasPendingKitchen = persistedItems.some(item => item.kitchenEligible && !item.sentToKitchen);
    const hasPendingLines = state.pendingLines.length > 0;

    if (hasPendingLines) {
      el.btnAddItems.classList.remove('hidden');
    } else {
      el.btnAddItems.classList.add('hidden');
    }

    if (hasPendingKitchen || hasPendingLines) {
      el.btnSendKitchen.disabled = false;
      el.btnSendKitchen.innerHTML = `${icon('send')}<span class="btn-label">Send to kitchen</span>`;
    } else {
      el.btnSendKitchen.disabled = true;
      el.btnSendKitchen.innerHTML = `${icon('check')}<span class="btn-label">All sent</span>`;
    }
  }

  // ----------------------------------------------------
  // 8. Commit Lines & Kitchen Send
  // ----------------------------------------------------
  async function savePendingLinesToTicket() {
    if (state.pendingLines.length === 0) return true;
    const t = state.activeTicket;

    const payload = {
      expectedRevision: t.revision,
      items: state.pendingLines.map(line => ({
        menuItemId: line.menuItemId,
        quantity: line.quantity,
        seatNumber: line.seatNumber,
        modifiers: line.modifiers || [],
        instructions: line.instructions || []
      }))
    };

    el.btnAddItems.disabled = true;
    el.btnAddItems.textContent = 'Saving...';

    try {
      const res = await api(`/api/tickets/${t.id}/items`, {
        method: 'POST',
        body: payload
      });

      state.activeTicket = res.ticket;
      state.pendingLines = [];
      showToast('Saved to tab', 'success');
      renderTicketPanel();
      return true;
    } catch (err) {
      showToast(`Error adding items: ${err.message}`, 'error');
      return false;
    } finally {
      el.btnAddItems.disabled = false;
      el.btnAddItems.textContent = 'Save to tab';
    }
  }

  async function handleSendToKitchen() {
    const t = state.activeTicket;
    if (!t) return;

    el.btnSendKitchen.disabled = true;
    el.btnSendKitchen.innerHTML = '<span class="btn-label">Sending...</span>';

    try {
      // 1. If unsaved pending lines exist, save them first
      if (state.pendingLines.length > 0) {
        const saved = await savePendingLinesToTicket();
        if (!saved) return;
      }

      // Latest ticket snapshot after item save
      const currentTicket = state.activeTicket;

      // 2. Dispatch to kitchen using kitchen_display deliveryMode!
      const sendPayload = {
        expectedRevision: currentTicket.revision,
        confirmed: true,
        deliveryMode: 'kitchen_display' // Direct digital delivery to KDS, no paper printer needed!
      };

      const sendRes = await api(`/api/tickets/${currentTicket.id}/send`, {
        method: 'POST',
        body: sendPayload
      });

      state.activeTicket = sendRes.ticket;
      showToast('Sent to the kitchen', 'success');
      renderTicketPanel();

      // Trigger background update of KDS board
      loadKds();
    } catch (err) {
      showToast(`Couldn't send to the kitchen: ${err.message}`, 'error');
      // Reload ticket to sync revision
      loadTicket(t.id);
    } finally {
      el.btnSendKitchen.disabled = false;
      renderTicketPanel();
    }
  }

  // ----------------------------------------------------
  // 9. Kitchen Display System (KDS) View
  // ----------------------------------------------------
  async function loadKds() {
    try {
      const res = await api('/api/kds');
      state.kdsTickets = res.tickets || [];
      renderKdsBoard();
    } catch (err) {
      el.kdsBoard.innerHTML = emptyState('alert', 'Can\'t load kitchen tickets', err.message);
    }
  }

  function renderKdsBoard() {
    // Collect all kitchen tickets from open tickets
    const allKitchenTickets = [];
    state.kdsTickets.forEach(item => {
      const parentTicket = item.ticket || {};
      (item.kitchenTickets || []).forEach(kt => {
        allKitchenTickets.push({
          parentTicketId: parentTicket.id,
          tables: kt.tableNumbers || parentTicket.tableNumbers || [],
          status: kt.status || 'WAITING',
          items: kt.items || [],
          sequence: kt.sequenceNumber || kt.id
        });
      });
    });

    el.kdsPendingCount.textContent = allKitchenTickets.length;

    if (allKitchenTickets.length === 0) {
      el.kdsBoard.innerHTML = emptyState('chef', 'No orders waiting', 'Orders sent to the kitchen show up here.');
      return;
    }

    el.kdsBoard.innerHTML = '';
    allKitchenTickets.forEach((kt, idx) => {
      const card = document.createElement('div');
      const statusLower = (kt.status || 'waiting').toLowerCase();
      card.className = `kds-ticket-card ${statusLower}`;

      const tableLabel = kt.tables.length > 0 ? `Table ${kt.tables.join(', ')}` : 'Bar';

      let itemsHtml = '';
      (kt.items || []).forEach(it => {
        itemsHtml += `
          <div class="kds-item-row">
            <div class="kds-item-main">
              <span class="kds-item-qty">${it.quantity}×</span>
              <span class="kds-item-name">${esc(it.name)}</span>
            </div>
            ${it.cookable ? '' : '<span class="item-badge">Ready to serve</span>'}
          </div>
        `;
      });

      card.innerHTML = `
        <div class="kds-ticket-header">
          <span class="kds-table-badge">${tableLabel}</span>
          <span class="kds-time-ago">#${kt.sequence}</span>
        </div>
        <div class="kds-ticket-meta">
          <span>Tab #${kt.parentTicketId}</span>
          <span class="table-status-pill ${statusLower}">${esc(kt.status.charAt(0) + kt.status.slice(1).toLowerCase())}</span>
        </div>
        <div class="kds-items-list">
          ${itemsHtml}
        </div>
        <div class="kds-ticket-footer">
          <button class="btn btn-secondary btn-sm btn-kds-bump">Acknowledge</button>
        </div>
      `;

      card.querySelector('.btn-kds-bump').addEventListener('click', () => {
        showToast(`${tableLabel} acknowledged`, 'info', 'check');
        card.style.opacity = '0.5';
      });

      el.kdsBoard.appendChild(card);
    });
  }

  // ----------------------------------------------------
  // 10. Tickets History & Audit View
  // ----------------------------------------------------
  async function loadOpenTickets() {
    try {
      const res = await api('/api/tables');
      const tables = res.tables || [];
      const ticketIds = new Set();
      tables.forEach(t => {
        if (t.openTicketIds) {
          t.openTicketIds.forEach(id => ticketIds.add(id));
        }
      });

      if (ticketIds.size === 0) {
        el.openTicketsList.innerHTML = '<div class="empty-state">No open tabs.</div>';
        return;
      }

      el.openTicketsList.innerHTML = '<div class="loading-spinner">Loading tabs...</div>';
      const tickets = [];
      for (const id of ticketIds) {
        try {
          const t = await api(`/api/tickets/${id}`);
          tickets.push(t.ticket);
        } catch {}
      }

      el.openTicketsList.innerHTML = '';
      tickets.forEach(ticket => {
        const row = document.createElement('div');
        row.className = 'ticket-row-item';
        row.innerHTML = `
          <div class="ticket-row-left">
            <span class="ticket-row-id">Tab #${ticket.id}</span>
            <span class="ticket-row-tables">Table ${ticket.tableNumbers?.join(', ') || '-'} · ${ticket.guestCount || 1} guests</span>
          </div>
          <span class="ticket-row-total">${formatMoney(ticket.total)}</span>
        `;
        row.addEventListener('click', () => {
          renderTicketDetail(ticket);
        });
        el.openTicketsList.appendChild(row);
      });
    } catch (err) {
      el.openTicketsList.innerHTML = `<div class="empty-state">${esc(err.message)}</div>`;
    }
  }

  function renderTicketDetail(ticket) {
    el.ticketDetailPanel.innerHTML = `
      <div class="card-header">
        <h3>Tab #${ticket.id}</h3>
        <button class="btn btn-primary btn-sm" id="btn-open-in-register">Open order</button>
      </div>
      <div class="detail-body">
        <div class="detail-meta">
          <span>Table ${ticket.tableNumbers?.join(', ') || '-'} · ${ticket.guestCount || 1} guests</span>
          <strong>${formatMoney(ticket.total)}</strong>
        </div>
        ${(ticket.items || []).map(i => `
          <div class="detail-row">
            <span>${i.quantity}× ${esc(i.name)}</span>
            <span>${formatMoney(i.total)}</span>
          </div>
        `).join('') || '<div class="empty-state">No items yet.</div>'}
      </div>
    `;

    document.getElementById('btn-open-in-register').addEventListener('click', () => {
      state.activeTicket = ticket;
      state.activeTableNumber = ticket.tableNumbers?.[0] || null;
      state.pendingLines = [];
      switchView('register');
    });
  }

  // ----------------------------------------------------
  // 11. Modal Utilities & Event Listeners
  // ----------------------------------------------------
  function closeModal(modalEl) {
    modalEl.classList.add('hidden');
  }

  function setupEventListeners() {
    // Nav buttons
    el.navBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        switchView(btn.dataset.view);
      });
    });

    // Close modals
    document.querySelectorAll('[data-close]').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = btn.dataset.close;
        const target = document.getElementById(targetId);
        if (target) closeModal(target);
      });
    });

    // Quick New Tab button
    // Open tab: show the free tables to pick from.
    el.btnQuickNewTab.addEventListener('click', () => {
      state.activeFilter = 'free';
      el.filterChips.forEach(c => c.classList.toggle('active', c.dataset.filter === 'free'));
      switchView('tables');
    });

    const btnTheme = document.getElementById('btn-theme');
    if (btnTheme) btnTheme.addEventListener('click', toggleTheme);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderThemeButton);

    // Banner check again
    el.bannerBtn.addEventListener('click', async () => {
      await checkHealth();
      await loadTables();
    });

    // Table filter chips
    el.filterChips.forEach(chip => {
      chip.addEventListener('click', () => {
        el.filterChips.forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        state.activeFilter = chip.dataset.filter;
        renderTables();
      });
    });

    // Table search
    el.tableSearch.addEventListener('input', (e) => {
      state.tableSearch = e.target.value;
      renderTables();
    });

    // Guest stepper
    el.btnGuestMinus.addEventListener('click', () => {
      let val = parseInt(el.guestCountVal.textContent, 10);
      if (val > 1) el.guestCountVal.textContent = String(val - 1);
    });
    el.btnGuestPlus.addEventListener('click', () => {
      let val = parseInt(el.guestCountVal.textContent, 10);
      if (val < 20) el.guestCountVal.textContent = String(val + 1);
    });

    // Confirm open tab
    el.btnConfirmOpenTab.addEventListener('click', confirmOpenTab);

    // Menu search
    el.menuSearch.addEventListener('input', (e) => {
      state.menuSearch = e.target.value;
      el.btnClearSearch.classList.toggle('hidden', !e.target.value);
      renderMenu();
    });

    el.btnClearSearch.addEventListener('click', () => {
      el.menuSearch.value = '';
      state.menuSearch = '';
      el.btnClearSearch.classList.add('hidden');
      renderMenu();
    });

    // Modal Qty stepper
    el.btnModalQtyMinus.addEventListener('click', () => {
      if (state.customizingQty > 1) {
        state.customizingQty--;
        el.modalQtyVal.textContent = String(state.customizingQty);
        updateModalTotal();
      }
    });
    el.btnModalQtyPlus.addEventListener('click', () => {
      if (state.customizingQty < 50) {
        state.customizingQty++;
        el.modalQtyVal.textContent = String(state.customizingQty);
        updateModalTotal();
      }
    });

    // Modal Add instruction tag
    el.btnModalAddInst.addEventListener('click', () => {
      const text = el.modalInstInput.value.trim();
      if (text) {
        state.customInstructions.push(text);
        el.modalInstInput.value = '';
        renderModalInstructions();
      }
    });
    el.modalInstInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        el.btnModalAddInst.click();
      }
    });

    // Modal Confirm add to order
    el.btnModalAddToOrder.addEventListener('click', addModalCustomizedItem);

    // Quick instruction chips on right bar
    el.quickInstChips.forEach(chip => {
      chip.addEventListener('click', () => {
        const inst = chip.dataset.inst;
        if (state.pendingLines.length > 0) {
          const lastLine = state.pendingLines[state.pendingLines.length - 1];
          if (!lastLine.instructions.includes(inst)) {
            lastLine.instructions.push(inst);
            renderTicketPanel();
            showToast(`Applied "${inst}" to ${lastLine.name}`, 'info');
          }
        } else {
          showToast('Add an item to the order first to attach instructions', 'info');
        }
      });
    });

    // Custom instruction button
    el.btnCustomInst.addEventListener('click', () => {
      if (state.pendingLines.length === 0) {
        showToast('Add an item to order first', 'info');
        return;
      }
      el.inputCustomInst.value = '';
      el.modalCustomInst.classList.remove('hidden');
    });

    el.btnConfirmCustomInst.addEventListener('click', () => {
      const text = el.inputCustomInst.value.trim();
      if (text && state.pendingLines.length > 0) {
        const lastLine = state.pendingLines[state.pendingLines.length - 1];
        lastLine.instructions.push(text);
        closeModal(el.modalCustomInst);
        renderTicketPanel();
        showToast(`Added note to ${lastLine.name}`, 'info');
      }
    });

    // Ticket buttons
    el.btnSwitchTable.addEventListener('click', () => switchView('tables'));
    el.btnRefreshTab.addEventListener('click', () => {
      if (state.activeTicket) loadTicket(state.activeTicket.id);
    });
    el.btnAddItems.addEventListener('click', savePendingLinesToTicket);
    el.btnSendKitchen.addEventListener('click', handleSendToKitchen);

    // KDS refresh
    el.btnRefreshKds.addEventListener('click', loadKds);

    // Tickets view
    el.btnRefreshOpenTickets.addEventListener('click', loadOpenTickets);
    el.btnLookupTicket.addEventListener('click', async () => {
      const id = parseInt(el.ticketLookupId.value, 10);
      if (id > 0) {
        try {
          const res = await api(`/api/tickets/${id}`);
          renderTicketDetail(res.ticket);
        } catch (e) {
          showToast(e.message, 'error');
        }
      }
    });

    // Voice Playground Listeners
    if (el.voiceForm) {
      el.voiceForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const cmd = el.voiceTextInput.value;
        if (cmd && cmd.trim()) {
          executeVoiceCommand(cmd.trim());
        }
      });
    }

    if (el.btnToggleTts) {
      el.btnToggleTts.addEventListener('click', () => setTtsEnabled(!ttsEnabled));
    }

    if (el.btnToggleMic) {
      el.btnToggleMic.addEventListener('click', () => (call.active ? endCall() : startCall()));
    }
    if (el.btnCallMute) el.btnCallMute.addEventListener('click', toggleMute);
    if (el.btnCallEnd) el.btnCallEnd.addEventListener('click', endCall);

    if (el.presetVoiceChips) {
      el.presetVoiceChips.forEach(chip => {
        chip.addEventListener('click', () => {
          const cmd = chip.dataset.cmd;
          if (cmd) {
            el.voiceTextInput.value = cmd;
            executeVoiceCommand(cmd);
          }
        });
      });
    }

    if (el.btnRejoinAgora) {
      el.btnRejoinAgora.addEventListener('click', async () => {
        try {
          showToast('Reconnecting Sora to Agora AI Agent channel...', 'info');
          const res = await api('/api/voice/reconnect', { method: 'POST' });
          showToast(res.message || 'Sora reconnected to Agora', 'success');
        } catch (err) {
          showToast(`Could not start Sora: ${err.message}`, 'error');
        }
        loadAgentStatus();
      });
    }
  }

  // ----------------------------------------------------
  // 12. Voice Agent Playground & Speech Integration
  // ----------------------------------------------------
  // The playground works like a phone call: once started, Sora listens hands-free, answers aloud,
  // then listens again. It is half-duplex: the mic is paused while Sora speaks so the recognizer
  // never transcribes her own voice.
  let recognition = null;
  let recognizing = false;
  let voiceSessionId = newVoiceSessionId();

  function newVoiceSessionId() {
    return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  const call = { active: false, muted: false, phase: 'idle', startedAt: 0, timer: null, restartTimer: null };

  const PHASES = {
    idle: { pill: '', label: 'Ready' },
    listening: { pill: 'listening', label: 'Listening...' },
    muted: { pill: 'muted', label: 'Muted' },
    thinking: { pill: 'thinking', label: 'Thinking...' },
    speaking: { pill: 'speaking', label: 'Sora speaking...' }
  };

  function setPhase(phase) {
    call.phase = phase;
    el.micStatusPill.className = `mic-status-pill ${PHASES[phase].pill}`.trim();
    el.micLabel.textContent = PHASES[phase].label;
    if (el.callBar) el.callBar.dataset.phase = phase;
  }

  function initSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.log('Web Speech API is not supported in this browser. Fallback to typed text/presets.');
      return;
    }

    try {
      recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = 'en-GB';

      recognition.onstart = () => {
        recognizing = true;
      };

      recognition.onresult = (event) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (result.isFinal) {
            const transcript = result[0].transcript.trim();
            if (transcript && call.phase === 'listening') {
              stopRecognition();
              executeVoiceCommand(transcript);
            }
            return;
          }
          interim += result[0].transcript;
        }
        // Live caption of what Sora is hearing
        if (interim) el.voiceTextInput.value = interim;
      };

      recognition.onerror = (event) => {
        // "no-speech" and "aborted" are routine during a call; onend restarts listening.
        if (event.error === 'no-speech' || event.error === 'aborted') return;
        console.warn('Speech recognition error:', event.error);
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed' || event.error === 'audio-capture') {
          showToast(event.error === 'audio-capture' ? 'No microphone found.' : 'Microphone permission was denied.', 'error');
          endCall({ silent: true });
          return;
        }
        showToast(`Mic error: ${event.error}`, 'error');
      };

      recognition.onend = () => {
        recognizing = false;
        // Browsers end recognition after a pause; keep the line open while the call is live.
        if (call.active && call.phase === 'listening') scheduleListen(250);
      };
    } catch (e) {
      console.warn('Speech recognition initialization failed:', e);
    }
  }

  function listen() {
    if (!call.active) return;
    if (call.muted) return setPhase('muted');
    setPhase('listening');
    if (recognizing) return;
    try {
      recognition.start();
    } catch (e) {
      // start() throws if a previous session is still closing; try again shortly.
      scheduleListen(300);
    }
  }

  function scheduleListen(delayMs) {
    clearTimeout(call.restartTimer);
    call.restartTimer = setTimeout(listen, delayMs);
  }

  function stopRecognition() {
    clearTimeout(call.restartTimer);
    if (recognition && recognizing) {
      try {
        recognition.abort();
      } catch (e) {}
    }
  }

  function formatCallDuration(ms) {
    const total = Math.floor(ms / 1000);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
  }

  function startCall() {
    if (!recognition) {
      showToast('Calls need speech recognition (Chrome, Edge or Safari). Use text input or quick presets.', 'info');
      return;
    }
    call.active = true;
    call.muted = false;
    call.startedAt = Date.now();
    el.callTimer.textContent = '00:00';
    call.timer = setInterval(() => {
      el.callTimer.textContent = formatCallDuration(Date.now() - call.startedAt);
    }, 1000);
    el.callBar.hidden = false;
    el.voiceForm.classList.add('in-call');
    updateMuteButton();
    appendTranscriptMessage('Call', 'Call started', true);
    // Greeting doubles as the user-gesture that unlocks speech output in Chrome/Safari.
    speakReply('Sora here. Go ahead.');
  }

  function endCall({ silent = false } = {}) {
    if (!call.active) return;
    const duration = formatCallDuration(Date.now() - call.startedAt);
    call.active = false;
    call.muted = false;
    clearInterval(call.timer);
    stopRecognition();
    stopSpeaking();
    el.callBar.hidden = true;
    el.voiceForm.classList.remove('in-call');
    el.voiceTextInput.value = '';
    setPhase('idle');
    appendTranscriptMessage('Call', `Call ended · ${duration}`, true);
    // Each call is its own conversation.
    api('/api/voice/session/reset', 'POST', { sessionId: voiceSessionId }).catch(() => {});
    voiceSessionId = newVoiceSessionId();
    if (!silent) showToast(`Call ended · ${duration}`, 'info', 'phone-off');
  }

  function toggleMute() {
    if (!call.active) return;
    call.muted = !call.muted;
    updateMuteButton();
    if (call.muted) {
      stopRecognition();
      // Let a reply in progress finish; Sora just stops hearing you.
      if (call.phase === 'listening') setPhase('muted');
    } else if (call.phase === 'muted') {
      listen();
    }
  }

  function updateMuteButton() {
    if (!el.btnCallMute) return;
    el.btnCallMute.setAttribute('aria-pressed', String(call.muted));
    el.btnCallMute.querySelector('.call-btn-icon').innerHTML = icon(call.muted ? 'mic-off' : 'mic');
    el.btnCallMute.querySelector('.call-btn-label').textContent = call.muted ? 'Unmute' : 'Mute';
  }

  // After Sora answers: keep listening if on a call, otherwise go back to idle.
  function resumeAfterReply() {
    if (call.active) listen();
    else setPhase('idle');
  }

  // ----------------------------------------------------
  // Text-to-speech for Sora's replies (browser speechSynthesis)
  // ----------------------------------------------------
  const tts = window.speechSynthesis || null;
  let ttsEnabled = true;
  let ttsVoice = null;
  try {
    ttsEnabled = localStorage.getItem('sora-tts') !== 'off';
  } catch (e) {}

  function pickTtsVoice() {
    if (!tts) return;
    const voices = tts.getVoices();
    const british = voices.filter(v => /^en[-_]GB/i.test(v.lang));
    // Prefer the natural-sounding UK voices shipped with Chrome/macOS, then any UK voice, then any English.
    ttsVoice = british.find(v => /Google UK English Female|Serena|Kate|Stephanie|Martha/i.test(v.name))
      || british[0]
      || voices.find(v => /^en/i.test(v.lang))
      || null;
  }

  function setTtsEnabled(enabled) {
    ttsEnabled = enabled && Boolean(tts);
    try {
      localStorage.setItem('sora-tts', ttsEnabled ? 'on' : 'off');
    } catch (e) {}
    if (!ttsEnabled) stopSpeaking();
    if (el.btnToggleTts) {
      el.btnToggleTts.setAttribute('aria-pressed', String(ttsEnabled));
      el.btnToggleTts.querySelector('.tts-icon').innerHTML = icon(ttsEnabled ? 'volume' : 'volume-off');
      el.btnToggleTts.querySelector('.tts-label').textContent = ttsEnabled ? 'Voice on' : 'Voice off';
    }
  }

  function initTts() {
    if (!tts) {
      if (el.btnToggleTts) {
        el.btnToggleTts.disabled = true;
        el.btnToggleTts.title = 'Speech output is not supported in this browser';
      }
      setTtsEnabled(false);
      return;
    }
    pickTtsVoice();
    tts.addEventListener('voiceschanged', pickTtsVoice);
    setTtsEnabled(ttsEnabled);
  }

  // Replies are written for the screen; tidy them so they sound natural when read aloud.
  function toSpokenText(text) {
    return String(text)
      .replace(/\s*\(Ticket #\d+\)/g, '')
      .replace(/#(\d+)/g, 'number $1')
      .replace(/\b(\d+)x\s+/g, '$1 ')
      .replace(/&/g, ' and ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  let currentUtterance = null;

  function speakReply(text) {
    if (!ttsEnabled || !tts || !text) return resumeAfterReply();
    stopSpeaking();
    const utterance = new SpeechSynthesisUtterance(toSpokenText(text));
    utterance.lang = 'en-GB';
    if (ttsVoice) utterance.voice = ttsVoice;
    utterance.rate = 1.05;
    // Ignore events from utterances that were cancelled and replaced.
    utterance.onstart = () => {
      if (utterance === currentUtterance) setPhase('speaking');
    };
    const done = () => {
      if (utterance !== currentUtterance) return;
      currentUtterance = null;
      resumeAfterReply();
    };
    utterance.onend = done;
    utterance.onerror = done;
    // Holding a reference also stops Chrome garbage-collecting the utterance before onend fires.
    currentUtterance = utterance;
    tts.speak(utterance);
    // Chrome occasionally never fires onend; don't leave the call stuck in "speaking".
    setTimeout(done, 4000 + utterance.text.length * 90);
  }

  function stopSpeaking() {
    currentUtterance = null;
    if (tts && (tts.speaking || tts.pending)) tts.cancel();
  }

  function appendTranscriptMessage(sender, text, isAgent = false) {
    if (!el.voiceTranscriptBox) return;

    const msg = document.createElement('div');
    msg.className = `transcript-msg ${sender === 'Call' ? 'system-msg' : (isAgent ? 'agent-msg' : 'user-msg')}`;
    
    // Built with textContent: transcripts and replies contain user speech and POS data.
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    const author = document.createElement('div');
    author.className = 'msg-author';
    author.textContent = sender;
    const body = document.createElement('div');
    body.className = 'msg-text';
    body.textContent = text;
    bubble.append(author, body);
    msg.appendChild(bubble);

    el.voiceTranscriptBox.appendChild(msg);
    el.voiceTranscriptBox.scrollTop = el.voiceTranscriptBox.scrollHeight;
  }

  async function executeVoiceCommand(text) {
    if (!text || !text.trim()) return;
    const cleanCmd = text.trim();

    // 1. Add user message to transcript
    appendTranscriptMessage('You', cleanCmd, false);
    stopRecognition();
    stopSpeaking();
    el.voiceTextInput.value = '';
    setPhase('thinking');

    try {
      // The server keeps the conversation (current table, held orders) per session.
      const res = await api('/api/voice/command', 'POST', { text: cleanCmd, sessionId: voiceSessionId });

      // Update Inspector
      if (el.lastToolBadge) el.lastToolBadge.textContent = res.action || 'reply only';
      if (el.lastToolJson) {
        el.lastToolJson.textContent = JSON.stringify(res, null, 2);
      }

      // Add agent reply
      appendTranscriptMessage('Sora', res.reply || 'Done.', true);
      speakReply(res.reply || 'Done.');

      // Refresh relevant POS components
      loadTables();
      if (state.activeTicket) {
        loadTicket(state.activeTicket.id);
      }
      if (state.activeView === 'kds') {
        loadKds();
      }

    } catch (err) {
      const errMsg = err.message || 'Error executing voice command';
      appendTranscriptMessage('Sora', errMsg, true);
      speakReply(errMsg);
      showToast(errMsg, 'error');
      if (el.lastToolJson) {
        el.lastToolJson.textContent = JSON.stringify({ error: errMsg }, null, 2);
      }
    }
  }

  async function loadAgentStatus() {
    if (!el.agentStatusLabel) return;
    try {
      const status = await api('/api/voice/agent');
      el.agentStatusLabel.textContent = status.running ? 'Running' : (status.agoraStatus && status.agoraStatus !== 'UNKNOWN' ? status.agoraStatus.toLowerCase() : 'Not running');
      if (el.activeAgentId && status.agentId) el.activeAgentId.textContent = status.agentId;
    } catch (e) {
      el.agentStatusLabel.textContent = 'Unknown';
    }
  }

  // ----------------------------------------------------
  // Initial Boot
  // ----------------------------------------------------
  async function init() {
    hydrateIcons();
    renderThemeButton();
    setupEventListeners();
    const initialView = location.hash.slice(1);
    if (initialView && initialView !== 'tables' && el.views[initialView]) switchView(initialView);
    initSpeechRecognition();
    initTts();
    await checkHealth();
    loadAgentStatus();
    await Promise.all([
      loadTables(),
      loadMenu()
    ]);

    // Poll health periodically
    setInterval(checkHealth, 5000);

    // Kitchen: live while on screen, and in the background so the nav count stays current.
    loadKds();
    let kdsTicks = 0;
    state.kdsAutoTimer = setInterval(() => {
      kdsTicks++;
      if (state.activeView === 'kds' || kdsTicks % 3 === 0) loadKds();
    }, 5000);
  }

  // Boot on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
