/**
 * BigQuery Release Notes Explorer
 * Frontend Application Script
 */

document.addEventListener('DOMContentLoaded', () => {
  // --- Application State ---
  const state = {
    notes: [],          // Raw list of parsed notes from API
    bookmarks: [],      // Array of bookmarked note IDs (loaded from localStorage)
    currentView: 'all', // 'all' or 'bookmarks'
    filters: {
      search: '',
      categories: new Set(),
      timeframe: 'all', // 'all', '30', '90', '180', '365'
      sort: 'desc'      // 'desc' or 'asc'
    },
    meta: {
      lastUpdated: '',
      source: 'fresh',
      totalItems: 0,
      stats: {}
    }
  };

  // --- UI Elements ---
  const bqLogo = document.getElementById('bqLogo');
  const themeToggle = document.getElementById('themeToggle');
  const refreshBtn = document.getElementById('refreshBtn');
  const metricsGrid = document.getElementById('metricsGrid');
  const searchInput = document.getElementById('searchInput');
  const clearSearch = document.getElementById('clearSearch');
  const tabTimeline = document.getElementById('tabTimeline');
  const tabBookmarks = document.getElementById('tabBookmarks');
  const bookmarkCount = document.getElementById('bookmarkCount');
  const categoryFilters = document.getElementById('categoryFilters');
  const timeFilter = document.getElementById('timeFilter');
  const sortOrder = document.getElementById('sortOrder');
  const cacheStatusCard = document.getElementById('cacheStatusCard');
  const timelineFeed = document.getElementById('timelineFeed');
  const toastContainer = document.getElementById('toastContainer');
  
  // Mobile Sidebar elements
  const filterToggleBtn = document.getElementById('filterToggleBtn');
  const closeSidebarBtn = document.getElementById('closeSidebarBtn');
  const filtersSidebar = document.getElementById('filtersSidebar');
  const sidebarOverlay = document.getElementById('sidebarOverlay');

  // --- Core Initialization ---
  initTheme();
  loadBookmarks();
  fetchNotes();
  setupEventListeners();

  // --- Theme Management ---
  function initTheme() {
    const savedTheme = localStorage.getItem('bq-notes-theme') || 'dark-theme';
    document.body.className = savedTheme;
  }

  function toggleTheme() {
    const isDark = document.body.classList.contains('dark-theme');
    const newTheme = isDark ? 'light-theme' : 'dark-theme';
    document.body.className = newTheme;
    localStorage.setItem('bq-notes-theme', newTheme);
    showToast(`Switched to ${isDark ? 'Light' : 'Dark'} mode`, 'info');
  }

  // --- Bookmark Management ---
  function loadBookmarks() {
    try {
      const stored = localStorage.getItem('bq-notes-bookmarks');
      state.bookmarks = stored ? JSON.parse(stored) : [];
      updateBookmarkCountUI();
    } catch (e) {
      console.error('Error loading bookmarks:', e);
      state.bookmarks = [];
    }
  }

  function toggleBookmark(noteId) {
    const idx = state.bookmarks.indexOf(noteId);
    if (idx === -1) {
      state.bookmarks.push(noteId);
      showToast('Bookmark saved!', 'success');
    } else {
      state.bookmarks.splice(idx, 1);
      showToast('Bookmark removed', 'info');
    }
    localStorage.setItem('bq-notes-bookmarks', JSON.stringify(state.bookmarks));
    updateBookmarkCountUI();
    
    // If we are currently in the bookmark tab, re-render immediately
    if (state.currentView === 'bookmarks') {
      renderTimeline();
    } else {
      // Toggle the active class on the individual card's button
      const card = document.querySelector(`.timeline-card[data-id="${noteId}"]`);
      if (card) {
        const btn = card.querySelector('.btn-bookmark');
        if (btn) btn.classList.toggle('bookmarked');
      }
    }
  }

  function updateBookmarkCountUI() {
    bookmarkCount.textContent = state.bookmarks.length;
  }

  // --- API Communication ---
  async function fetchNotes(force = false) {
    showLoadingState();
    
    // Start button spinner
    const refreshIcon = refreshBtn.querySelector('.refresh-icon');
    if (refreshIcon) refreshIcon.classList.add('spinning');
    refreshBtn.disabled = true;
    
    const url = `/api/notes${force ? '?force=true' : ''}`;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      
      if (data.status === 'success') {
        state.notes = data.notes;
        state.meta.lastUpdated = data.last_updated;
        state.meta.source = data.source;
        state.meta.totalItems = data.total_items;
        state.meta.stats = data.stats;
        
        updateCacheStatusUI();
        updateMetricsUI();
        renderCategoryFilters();
        renderTimeline();
        
        if (force) {
          showToast('Feed synchronized successfully!', 'success');
        }
      } else {
        throw new Error(data.message || 'Unknown server error');
      }
    } catch (error) {
      console.error('Error fetching release notes:', error);
      showToast('Failed to load release notes. Using cached data if available.', 'error');
      showEmptyState('Connection Error', 'Could not retrieve notes from the server. Check your connection or retry sync.');
    } finally {
      // Stop button spinner
      if (refreshIcon) refreshIcon.classList.remove('spinning');
      refreshBtn.disabled = false;
    }
  }

  // --- UI Renderers ---
  function showLoadingState() {
    // Fill categories and metrics with skeleton placeholders
    metricsGrid.innerHTML = `
      <div class="metric-card loading-skeleton" style="height: 82px;"></div>
      <div class="metric-card loading-skeleton" style="height: 82px;"></div>
      <div class="metric-card loading-skeleton" style="height: 82px;"></div>
      <div class="metric-card loading-skeleton" style="height: 82px;"></div>
    `;
    
    categoryFilters.innerHTML = `
      <div class="filter-pill-loader loading-skeleton" style="width: 80px; height: 32px; border-radius: 9999px;"></div>
      <div class="filter-pill-loader loading-skeleton" style="width: 90px; height: 32px; border-radius: 9999px;"></div>
      <div class="filter-pill-loader loading-skeleton" style="width: 85px; height: 32px; border-radius: 9999px;"></div>
    `;

    timelineFeed.innerHTML = `
      <div class="skeleton-card"></div>
      <div class="skeleton-card"></div>
      <div class="skeleton-card"></div>
    `;
  }

  function updateCacheStatusUI() {
    const dot = cacheStatusCard.querySelector('.status-dot');
    const text = cacheStatusCard.querySelector('.status-text');
    const time = cacheStatusCard.querySelector('.status-time');
    
    dot.className = 'status-dot';
    
    if (state.meta.source === 'fresh') {
      dot.classList.add('fresh');
      text.textContent = 'Live Feed (Synced)';
    } else if (state.meta.source === 'file_cache') {
      dot.classList.add('cached');
      text.textContent = 'Cached Feed';
    } else {
      dot.classList.add('error');
      text.textContent = 'Offline Mode';
    }
    
    time.textContent = `Last update: ${state.meta.lastUpdated}`;
  }

  function updateMetricsUI() {
    // We compute metrics from the parsed list
    const total = state.notes.length;
    const features = state.notes.filter(n => n.category === 'Feature').length;
    const issues = state.notes.filter(n => n.category === 'Issue').length;
    const breaking = state.notes.filter(n => n.category === 'Breaking').length;

    metricsGrid.innerHTML = `
      <div class="metric-card metric-total">
        <div class="metric-icon-box">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"></path></svg>
        </div>
        <div class="metric-info">
          <span class="metric-value">${total}</span>
          <span class="metric-label">Total Notes</span>
        </div>
      </div>
      
      <div class="metric-card metric-features">
        <div class="metric-icon-box">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
        </div>
        <div class="metric-info">
          <span class="metric-value">${features}</span>
          <span class="metric-label">Features</span>
        </div>
      </div>

      <div class="metric-card metric-issues">
        <div class="metric-icon-box">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
        </div>
        <div class="metric-info">
          <span class="metric-value">${issues}</span>
          <span class="metric-label">Issues</span>
        </div>
      </div>

      <div class="metric-card metric-breaking">
        <div class="metric-icon-box">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line></svg>
        </div>
        <div class="metric-info">
          <span class="metric-value">${breaking}</span>
          <span class="metric-label">Breaking</span>
        </div>
      </div>
    `;
  }

  function renderCategoryFilters() {
    // Find all unique categories from notes
    const counts = {};
    state.notes.forEach(note => {
      counts[note.category] = (counts[note.category] || 0) + 1;
    });

    categoryFilters.innerHTML = '';
    
    Object.keys(counts).sort().forEach(cat => {
      const activeClass = state.filters.categories.has(cat) ? 'active' : '';
      const pill = document.createElement('button');
      pill.className = `category-pill ${activeClass}`;
      pill.setAttribute('data-category', cat);
      pill.innerHTML = `
        <span>${cat}</span>
        <span class="category-count">${counts[cat]}</span>
      `;
      
      pill.addEventListener('click', () => {
        if (state.filters.categories.has(cat)) {
          state.filters.categories.delete(cat);
          pill.classList.remove('active');
        } else {
          state.filters.categories.add(cat);
          pill.classList.add('active');
        }
        renderTimeline();
      });
      
      categoryFilters.appendChild(pill);
    });
  }

  function renderTimeline() {
    // Filter and Sort the data
    const filteredNotes = filterNotes();
    
    if (filteredNotes.length === 0) {
      showEmptyState('No updates found', 'Try modifying your filters or search keywords to see results.');
      return;
    }

    timelineFeed.innerHTML = '';
    
    // Render the cards
    filteredNotes.forEach(note => {
      const card = createTimelineCard(note);
      timelineFeed.appendChild(card);
    });
  }

  function filterNotes() {
    let result = [...state.notes];

    // Filter by tab view
    if (state.currentView === 'bookmarks') {
      result = result.filter(n => state.bookmarks.includes(n.id));
    }

    // Filter by categories
    if (state.filters.categories.size > 0) {
      result = result.filter(n => state.filters.categories.has(n.category));
    }

    // Filter by timeframe
    if (state.filters.timeframe !== 'all') {
      const daysLimit = parseInt(state.filters.timeframe);
      const now = new Date('2026-06-16T19:05:58+03:00'); // Use fixed system time for consistent local comparison
      
      result = result.filter(n => {
        const itemDate = new Date(n.raw_date);
        const diffTime = Math.abs(now - itemDate);
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        return diffDays <= daysLimit;
      });
    }

    // Filter by search string
    if (state.filters.search) {
      const query = state.filters.search.toLowerCase();
      result = result.filter(n => {
        return (
          n.content.toLowerCase().includes(query) ||
          n.category.toLowerCase().includes(query) ||
          n.date.toLowerCase().includes(query)
        );
      });
    }

    // Sort notes
    result.sort((a, b) => {
      const dateA = new Date(a.raw_date);
      const dateB = new Date(b.raw_date);
      return state.filters.sort === 'desc' ? dateB - dateA : dateA - dateB;
    });

    return result;
  }

  function createTimelineCard(note) {
    const isBookmarked = state.bookmarks.includes(note.id);
    const card = document.createElement('article');
    card.className = 'timeline-card';
    card.setAttribute('data-category', note.category);
    card.setAttribute('data-id', note.id);

    // Dynamic Category Icons
    let categoryIcon = '';
    switch(note.category) {
      case 'Feature':
        categoryIcon = `<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>`;
        break;
      case 'Issue':
        categoryIcon = `<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>`;
        break;
      case 'Breaking':
        categoryIcon = `<circle cx="12" cy="12" r="10"></circle><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line>`;
        break;
      case 'Change':
        categoryIcon = `<path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>`;
        break;
      default:
        categoryIcon = `<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line>`;
    }

    card.innerHTML = `
      <div class="card-dot"></div>
      
      <div class="card-header">
        <div class="card-meta-left">
          <span class="card-badge">${note.category}</span>
          <span class="card-date">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
            ${note.date}
          </span>
        </div>
        
        <div class="card-actions">
          <button class="card-action-btn btn-bookmark ${isBookmarked ? 'bookmarked' : ''}" aria-label="Bookmark this release note">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="bookmark-svg"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>
          </button>
          <button class="card-action-btn btn-tweet" aria-label="Share on X (Twitter)">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
          </button>
          <button class="card-action-btn btn-copy-text" aria-label="Copy note text to clipboard">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
          </button>
          <button class="card-action-btn btn-copy" aria-label="Copy direct link to clipboard">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
          </button>
        </div>
      </div>

      <div class="card-body">
        ${note.content}
      </div>

      <div class="card-footer">
        <a href="${note.link}" target="_blank" rel="noopener noreferrer" class="link-original">
          <span>Google Cloud Release Notes</span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="7" y1="17" x2="17" y2="7"></line><polyline points="7 7 17 7 17 17"></polyline></svg>
        </a>
      </div>
    `;

    // Bind event listeners to dynamic buttons
    card.querySelector('.btn-bookmark').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleBookmark(note.id);
    });

    card.querySelector('.btn-tweet').addEventListener('click', (e) => {
      e.stopPropagation();
      shareOnTwitter(note);
    });

    card.querySelector('.btn-copy-text').addEventListener('click', (e) => {
      e.stopPropagation();
      copyTextToClipboard(note);
    });

    card.querySelector('.btn-copy').addEventListener('click', (e) => {
      e.stopPropagation();
      copyToClipboard(note.link);
    });

    return card;
  }

  function showEmptyState(title, description) {
    timelineFeed.innerHTML = `
      <div class="empty-state">
        <svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="8" y1="12" x2="16" y2="12"></line></svg>
        <h3 class="empty-title">${title}</h3>
        <p class="empty-desc">${description}</p>
        <button id="resetFiltersBtn" class="btn-primary">Reset Filters</button>
      </div>
    `;
    
    const resetBtn = document.getElementById('resetFiltersBtn');
    if (resetBtn) {
      resetBtn.addEventListener('click', resetAllFilters);
    }
  }

  function resetAllFilters() {
    searchInput.value = '';
    state.filters.search = '';
    clearSearch.style.display = 'none';
    
    state.filters.categories.clear();
    const pills = categoryFilters.querySelectorAll('.category-pill');
    pills.forEach(p => p.classList.remove('active'));
    
    timeFilter.value = 'all';
    state.filters.timeframe = 'all';
    
    sortOrder.value = 'desc';
    state.filters.sort = 'desc';
    
    renderTimeline();
    showToast('Filters cleared', 'info');
  }

  // --- Event Listeners Setup ---
  function setupEventListeners() {
    // Theme Toggle
    themeToggle.addEventListener('click', toggleTheme);

    // Export CSV Button
    const exportCsvBtn = document.getElementById('exportCsvBtn');
    if (exportCsvBtn) {
      exportCsvBtn.addEventListener('click', exportToCSV);
    }

    // Sync Button
    refreshBtn.addEventListener('click', () => {
      fetchNotes(true);
    });

    // Search Input
    searchInput.addEventListener('input', (e) => {
      state.filters.search = e.target.value;
      clearSearch.style.display = e.target.value ? 'block' : 'none';
      renderTimeline();
    });

    clearSearch.addEventListener('click', () => {
      searchInput.value = '';
      state.filters.search = '';
      clearSearch.style.display = 'none';
      renderTimeline();
    });

    // View tabs toggle
    tabTimeline.addEventListener('click', () => {
      if (state.currentView !== 'all') {
        state.currentView = 'all';
        tabTimeline.classList.add('active');
        tabBookmarks.classList.remove('active');
        renderTimeline();
      }
    });

    tabBookmarks.addEventListener('click', () => {
      if (state.currentView !== 'bookmarks') {
        state.currentView = 'bookmarks';
        tabBookmarks.classList.add('active');
        tabTimeline.classList.remove('active');
        renderTimeline();
      }
    });

    // Time filter dropdown
    timeFilter.addEventListener('change', (e) => {
      state.filters.timeframe = e.target.value;
      renderTimeline();
    });

    // Sort order dropdown
    sortOrder.addEventListener('change', (e) => {
      state.filters.sort = e.target.value;
      renderTimeline();
    });

    // Mobile Sidebar Toggles
    if (filterToggleBtn) {
      filterToggleBtn.addEventListener('click', () => {
        filtersSidebar.classList.add('active');
        sidebarOverlay.classList.add('active');
        document.body.style.overflow = 'hidden'; // Prevent scrolling background page
      });
    }

    const closeMobileSidebar = () => {
      if (filtersSidebar) filtersSidebar.classList.remove('active');
      if (sidebarOverlay) sidebarOverlay.classList.remove('active');
      document.body.style.overflow = ''; // Restore scrolling
    };

    if (closeSidebarBtn) {
      closeSidebarBtn.addEventListener('click', closeMobileSidebar);
    }

    if (sidebarOverlay) {
      sidebarOverlay.addEventListener('click', closeMobileSidebar);
    }

    // Close mobile sidebar on tab change
    tabTimeline.addEventListener('click', closeMobileSidebar);
    tabBookmarks.addEventListener('click', closeMobileSidebar);
  }

  // --- Utility Functions ---
  function exportToCSV() {
    const filtered = filterNotes();
    if (filtered.length === 0) {
      showToast('No notes to export', 'error');
      return;
    }
    
    // Define CSV headers
    const headers = ['ID', 'Date', 'Raw Date', 'Category', 'Description', 'Link'];
    
    // Format rows (strip HTML and handle escaping)
    const rows = filtered.map(note => {
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = note.content;
      const cleanContent = (tempDiv.textContent || tempDiv.innerText || "").trim().replace(/\s+/g, ' ');
      
      return [
        note.id,
        note.date,
        note.raw_date,
        note.category,
        cleanContent,
        note.link
      ];
    });
    
    // Build CSV file string
    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(val => {
        const escaped = String(val).replace(/"/g, '""');
        return `"${escaped}"`;
      }).join(','))
    ].join('\n');
    
    // Trigger download
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `bigquery_release_notes_${new Date().toISOString().slice(0, 10)}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    showToast(`Exported ${filtered.length} updates to CSV!`, 'success');
  }

  function copyTextToClipboard(note) {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = note.content;
    let text = tempDiv.textContent || tempDiv.innerText || "";
    text = text.trim();
    
    const formattedText = `BigQuery Update (${note.date}) - [${note.category}]:\n${text}\n\nSource: ${note.link}`;
    
    if (navigator.clipboard) {
      navigator.clipboard.writeText(formattedText)
        .then(() => {
          showToast('Note text copied to clipboard!', 'success');
        })
        .catch(err => {
          console.error('Failed to copy text: ', err);
          fallbackCopyText(formattedText, 'Note text copied to clipboard!');
        });
    } else {
      fallbackCopyText(formattedText, 'Note text copied to clipboard!');
    }
  }

  function shareOnTwitter(note) {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = note.content;
    let text = tempDiv.textContent || tempDiv.innerText || "";
    
    // Clean up whitespace/newlines
    text = text.replace(/\s+/g, ' ').trim();
    
    // Truncate to fit within Twitter's 280-char limit safely
    const maxLength = 130;
    if (text.length > maxLength) {
      text = text.substring(0, maxLength) + '...';
    }
    
    // Format tweet content
    const tweetText = `Google Cloud BigQuery Update (${note.date}): "${text}" #BigQuery #GoogleCloud`;
    
    // Construct intent URL
    const tweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}&url=${encodeURIComponent(note.link)}`;
    
    window.open(tweetUrl, '_blank', 'noopener,noreferrer');
  }

  function copyToClipboard(text) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text)
        .then(() => {
          showToast('Direct link copied to clipboard!', 'success');
        })
        .catch(err => {
          console.error('Failed to copy: ', err);
          fallbackCopyText(text, 'Direct link copied to clipboard!');
        });
    } else {
      fallbackCopyText(text, 'Direct link copied to clipboard!');
    }
  }

  function fallbackCopyText(text, successMessage = 'Direct link copied to clipboard!') {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed'; // Avoid scrolling to bottom
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      document.execCommand('copy');
      showToast(successMessage, 'success');
    } catch (err) {
      console.error('Fallback copy failed', err);
      showToast('Could not copy to clipboard', 'error');
    }
    document.body.removeChild(textArea);
  }

  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    let icon = '';
    if (type === 'success') {
      icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px;height:18px;color:var(--color-feature);"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>`;
    } else if (type === 'error') {
      icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px;height:18px;color:var(--color-breaking);"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`;
    } else {
      icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px;height:18px;color:var(--color-announcement);"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;
    }

    toast.innerHTML = `
      ${icon}
      <span>${message}</span>
    `;

    toastContainer.appendChild(toast);

    // Fade out and remove
    setTimeout(() => {
      toast.classList.add('fade-out');
      toast.addEventListener('animationend', () => {
        toast.remove();
      });
    }, 3000);
  }
});
