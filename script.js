/**
 * LUMEN Photography Portfolio - Core Engine
 * Dynamic JSON Loader, Filtering, Lightbox, & Theme Switcher
 */

(function () {
  "use strict";

  // -------------------------------------------------------------------------
  // State Management
  // -------------------------------------------------------------------------
  const state = {
    allImages: [],
    filteredImages: [],
    currentCategory: "all",
    lightboxIndex: 0,
    theme: "dark",
    galleryReady: false,
    enterRequested: false,
    swarmStarted: false,
    carousels: []
  };

  const SWARM_AUTOSTART = true;

  // DOM Elements Cache
  const DOM = {
    html: document.documentElement,
    themeToggle: document.getElementById("themeToggle"),
    filterBar: document.getElementById("filterBar"),
    galleryGrid: document.getElementById("galleryGrid"),
    galleryStatus: document.getElementById("galleryStatus"),
    totalCountBadge: document.getElementById("totalCountBadge"),

    // Lightbox
    lightbox: document.getElementById("lightbox"),
    lightboxBackdrop: document.getElementById("lightboxBackdrop"),
    lightboxImage: document.getElementById("lightboxImage"),
    lightboxClose: document.getElementById("lightboxClose"),
    lightboxPrev: document.getElementById("lightboxPrev"),
    lightboxNext: document.getElementById("lightboxNext"),
    lightboxSpinner: document.getElementById("lightboxSpinner"),
    lightboxCounter: document.getElementById("lightboxCounter"),
    lightboxTitle: document.getElementById("lightboxTitle"),
    lightboxCategory: document.getElementById("lightboxCategory")
  };

  // -------------------------------------------------------------------------
  // Theme Management (Light / Dark)
  // -------------------------------------------------------------------------
  function initTheme() {
    const savedTheme = localStorage.getItem("lumen_portfolio_theme");
    const systemPrefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    
    state.theme = savedTheme ? savedTheme : (systemPrefersDark ? "dark" : "light");
    applyTheme(state.theme);

    DOM.themeToggle?.addEventListener("click", () => {
      state.theme = state.theme === "dark" ? "light" : "dark";
      applyTheme(state.theme);
      localStorage.setItem("lumen_portfolio_theme", state.theme);
    });
  }

  function applyTheme(theme) {
    DOM.html.setAttribute("data-theme", theme);
  }

  // -------------------------------------------------------------------------
  // Fetch Image Data from images.json
  // -------------------------------------------------------------------------
  async function loadImages() {
    renderSkeletons(8);

    try {
      const response = await fetch(`images.json?t=${Date.now()}`);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      if (!Array.isArray(data) || data.length === 0) {
        throw new Error("Invalid or empty JSON array received.");
      }
      state.allImages = data;
    } catch (err) {
      console.warn("Could not fetch images.json directly (likely opened via file:// protocol). Loading fallback dataset.", err);
      state.allImages = getFallbackDataset();
    }

    state.filteredImages = [...state.allImages];
    initCategories();
    renderGallery();
  }

  // -------------------------------------------------------------------------
  // Render Skeleton Placeholders
  // -------------------------------------------------------------------------
  function renderSkeletons() {
    DOM.galleryGrid.innerHTML = "";
    DOM.galleryGrid.className = "gallery-rails";
    for (let s = 0; s < 2; s++) {
      const rail = document.createElement("div");
      rail.className = "category-rail";
      rail.innerHTML = `
        <div class="category-rail-header">
          <div class="skeleton-line skeleton-title"></div>
          <div class="skeleton-line skeleton-btn"></div>
        </div>
        <div class="category-viewport">
          <div class="category-track">
            ${[0, 1, 2, 3].map(() => `<div class="skeleton-card"></div>`).join("")}
          </div>
        </div>
      `;
      DOM.galleryGrid.appendChild(rail);
    }
  }

  // -------------------------------------------------------------------------
  // Category Navigation & Filtering
  // -------------------------------------------------------------------------
  function initCategories() {
    // Extract unique categories
    const categories = ["all", ...new Set(state.allImages.map(img => img.category.trim()))];

    // Compute counts
    const counts = { all: state.allImages.length };
    state.allImages.forEach(img => {
      const cat = img.category.trim();
      counts[cat] = (counts[cat] || 0) + 1;
    });

    if (DOM.totalCountBadge) {
      DOM.totalCountBadge.textContent = state.allImages.length;
    }

    // Render filter pills
    DOM.filterBar.innerHTML = "";
    categories.forEach(cat => {
      const isAll = cat.toLowerCase() === "all";
      const btn = document.createElement("button");
      btn.className = `filter-pill ${state.currentCategory.toLowerCase() === cat.toLowerCase() ? "active" : ""}`;
      btn.dataset.category = cat;
      btn.setAttribute("type", "button");
      btn.innerHTML = `
        ${isAll ? "All Works" : cat}
        <span class="counter-badge">${counts[cat] || 0}</span>
      `;

      btn.addEventListener("click", () => {
        handleCategoryChange(cat, btn);
      });

      DOM.filterBar.appendChild(btn);
    });
  }

  function handleCategoryChange(category, clickedBtn) {
    state.currentCategory = category;

    DOM.filterBar.querySelectorAll(".filter-pill").forEach((el) => {
      const match = el.dataset.category?.toLowerCase() === category.toLowerCase();
      el.classList.toggle("active", match);
    });
    if (clickedBtn && clickedBtn.classList) {
      clickedBtn.classList.add("active");
    }

    if (category.toLowerCase() === "all") {
      state.filteredImages = [...state.allImages];
    } else {
      state.filteredImages = state.allImages.filter(
        (img) => img.category.toLowerCase() === category.toLowerCase()
      );
    }

    renderGallery();
  }

  // -------------------------------------------------------------------------
  // Render Gallery — category rails + auto-slide carousels
  // -------------------------------------------------------------------------
  function stopAllCarousels() {
    state.carousels.forEach((c) => {
      clearInterval(c.timer);
      if (c.viewport) {
        c.viewport.onmouseenter = null;
        c.viewport.onmouseleave = null;
        c.viewport.ontouchstart = null;
        c.viewport.ontouchend = null;
      }
    });
    state.carousels = [];
  }

  function groupImagesByCategory(images) {
    const order = [];
    const map = new Map();
    images.forEach((img, index) => {
      const cat = (img.category || "Other").trim();
      if (!map.has(cat)) {
        map.set(cat, []);
        order.push(cat);
      }
      map.get(cat).push({ img, index });
    });
    return { order, map };
  }

  function createGalleryCard(item, globalIndex) {
    const card = document.createElement("article");
    card.className = "gallery-card";
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `View ${item.title} in full resolution`);
    card.dataset.index = String(globalIndex);

    const aspectClass = item.aspect ? `aspect-${item.aspect}` : "aspect-natural";

    card.innerHTML = `
      <div class="card-media-wrapper ${aspectClass}">
        <img
          class="card-img"
          src="${item.url}"
          alt="${item.title}"
          loading="lazy"
          decoding="async"
        />
        <div class="card-overlay">
          <span class="card-tag">${item.category}</span>
          <h3 class="card-title">${item.title}</h3>
        </div>
      </div>
    `;

    card.addEventListener("click", () => openLightbox(globalIndex));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openLightbox(globalIndex);
      }
    });

    return card;
  }

  function initCarousel(viewport, track) {
    const gap = () => {
      const styles = getComputedStyle(track);
      return parseFloat(styles.columnGap || styles.gap) || 16;
    };

    const isMobile = () => window.matchMedia("(max-width: 768px)").matches;

    const stepSize = () => {
      if (isMobile()) {
        return track.clientWidth || viewport.clientWidth;
      }
      const card = track.querySelector(".gallery-card");
      if (!card) return track.clientWidth * 0.5;
      return card.getBoundingClientRect().width + gap();
    };

    const go = (dir) => {
      const max = track.scrollWidth - track.clientWidth;
      if (max <= 4) return;
      const next = track.scrollLeft + dir * stepSize();
      if (dir > 0 && next >= max - 2) {
        track.scrollTo({ left: 0, behavior: "smooth" });
      } else if (dir < 0 && next <= 2) {
        track.scrollTo({ left: max, behavior: "smooth" });
      } else {
        track.scrollBy({ left: dir * stepSize(), behavior: "smooth" });
      }
    };

    let paused = false;
    const timer = setInterval(() => {
      if (paused || document.hidden) return;
      go(1);
    }, 3400);

    const pause = () => { paused = true; };
    const resume = () => { paused = false; };

    viewport.addEventListener("mouseenter", pause);
    viewport.addEventListener("mouseleave", resume);
    viewport.addEventListener("touchstart", pause, { passive: true });
    viewport.addEventListener("touchend", resume, { passive: true });

    const prevBtn = viewport.querySelector(".rail-nav.prev");
    const nextBtn = viewport.querySelector(".rail-nav.next");
    prevBtn?.addEventListener("click", (e) => {
      e.preventDefault();
      go(-1);
    });
    nextBtn?.addEventListener("click", (e) => {
      e.preventDefault();
      go(1);
    });

    state.carousels.push({ timer, viewport, track });
  }

  function renderCategoryRail(category, entries, { showViewAll }) {
    const rail = document.createElement("section");
    rail.className = "category-rail";
    rail.dataset.category = category;

    const header = document.createElement("div");
    header.className = "category-rail-header";

    const title = document.createElement("h2");
    title.className = "category-rail-title";
    title.textContent = category;

    header.appendChild(title);

    if (showViewAll) {
      const viewAll = document.createElement("button");
      viewAll.type = "button";
      viewAll.className = "view-all-btn";
      viewAll.textContent = "View all";
      viewAll.addEventListener("click", () => {
        handleCategoryChange(category);
        document.getElementById("gallery")?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      header.appendChild(viewAll);
    }

    const viewport = document.createElement("div");
    viewport.className = "category-viewport";

    viewport.innerHTML = `
      <button type="button" class="rail-nav prev" aria-label="Previous ${category} photos">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"></polyline></svg>
      </button>
      <button type="button" class="rail-nav next" aria-label="Next ${category} photos">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>
      </button>
    `;

    const track = document.createElement("div");
    track.className = "category-track";
    track.setAttribute("role", "list");

    const PAGE_SIZE = 4;
    for (let i = 0; i < entries.length; i += PAGE_SIZE) {
      const page = document.createElement("div");
      page.className = "category-page";
      entries.slice(i, i + PAGE_SIZE).forEach(({ img, index }) => {
        const card = createGalleryCard(img, index);
        card.setAttribute("role", "listitem");
        page.appendChild(card);
      });
      track.appendChild(page);
    }

    viewport.appendChild(track);
    rail.appendChild(header);
    rail.appendChild(viewport);
    DOM.galleryGrid.appendChild(rail);

    initCarousel(viewport, track);
  }

  function renderGallery() {
    stopAllCarousels();
    DOM.galleryGrid.innerHTML = "";
    DOM.galleryGrid.className = "gallery-rails";

    if (state.filteredImages.length === 0) {
      DOM.galleryStatus.textContent = `No images found for category "${state.currentCategory}".`;
      state.galleryReady = true;
      notifySwarmOfGallery();
      tryStartSwarm();
      return;
    }

    DOM.galleryStatus.textContent = "";

    const showingAll = state.currentCategory.toLowerCase() === "all";
    const { order, map } = groupImagesByCategory(state.filteredImages);

    if (showingAll) {
      order.forEach((cat) => {
        renderCategoryRail(cat, map.get(cat), { showViewAll: true });
      });
    } else {
      const cat = state.currentCategory.trim();
      const entries = map.get(cat) || [...map.values()][0] || [];
      renderCategoryRail(cat, entries, { showViewAll: false });
    }

    state.galleryReady = true;
    notifySwarmOfGallery();
    tryStartSwarm();
  }

  // -------------------------------------------------------------------------
  // Swarm rebuild helpers
  // -------------------------------------------------------------------------
  function notifySwarmOfGallery() {
    const swarm = window.__swarmRebuild;
    if (!swarm || !swarm.app || typeof swarm.refresh !== "function") return;
    swarm.refresh(DOM.galleryGrid);
  }

  function tryStartSwarm() {
    if (!SWARM_AUTOSTART || !state.enterRequested || !state.galleryReady) return;
    const swarm = window.__swarmRebuild;
    if (!swarm || typeof swarm.start !== "function" || swarm.app || state.swarmStarted) return;

    state.swarmStarted = true;
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    setTimeout(() => {
      try {
        swarm.start();
      } catch (err) {
        state.swarmStarted = false;
        console.warn("Swarm rebuild failed to start.", err);
      }
    }, 80);
  }

  // -------------------------------------------------------------------------
  // Lightbox Modal System
  // -------------------------------------------------------------------------
  function openLightbox(index) {
    if (!state.filteredImages[index]) return;

    state.lightboxIndex = index;
    DOM.lightbox.removeAttribute("hidden");
    // Trigger CSS transition
    requestAnimationFrame(() => {
      DOM.lightbox.classList.add("is-open");
    });

    document.body.style.overflow = "hidden"; // Prevent page scroll
    updateLightboxContent();
    DOM.lightboxClose.focus();
  }

  function closeLightbox() {
    DOM.lightbox.classList.remove("is-open");
    setTimeout(() => {
      DOM.lightbox.setAttribute("hidden", "");
      DOM.lightboxImage.src = "";
      document.body.style.overflow = "";
    }, 250);
  }

  function updateLightboxContent() {
    const currentItem = state.filteredImages[state.lightboxIndex];
    if (!currentItem) return;

    DOM.lightboxSpinner.classList.add("active");
    DOM.lightboxImage.classList.remove("loaded");

    // Preload & show image
    const tempImg = new Image();
    tempImg.src = currentItem.url;
    tempImg.onload = () => {
      DOM.lightboxImage.src = currentItem.url;
      DOM.lightboxImage.alt = currentItem.title;
      DOM.lightboxSpinner.classList.remove("active");
      DOM.lightboxImage.classList.add("loaded");
    };

    DOM.lightboxTitle.textContent = currentItem.title;
    DOM.lightboxCategory.textContent = currentItem.category;
    DOM.lightboxCounter.textContent = `${state.lightboxIndex + 1} / ${state.filteredImages.length}`;

    // Preload next & previous images for instant transitions
    preloadAdjacent();
  }

  function nextImage() {
    if (state.filteredImages.length <= 1) return;
    state.lightboxIndex = (state.lightboxIndex + 1) % state.filteredImages.length;
    updateLightboxContent();
  }

  function prevImage() {
    if (state.filteredImages.length <= 1) return;
    state.lightboxIndex = (state.lightboxIndex - 1 + state.filteredImages.length) % state.filteredImages.length;
    updateLightboxContent();
  }

  function preloadAdjacent() {
    const nextIdx = (state.lightboxIndex + 1) % state.filteredImages.length;
    const prevIdx = (state.lightboxIndex - 1 + state.filteredImages.length) % state.filteredImages.length;

    if (state.filteredImages[nextIdx]) {
      const nextPreload = new Image();
      nextPreload.src = state.filteredImages[nextIdx].url;
    }
    if (state.filteredImages[prevIdx]) {
      const prevPreload = new Image();
      prevPreload.src = state.filteredImages[prevIdx].url;
    }
  }

  // -------------------------------------------------------------------------
  // Keyboard & Touch Navigation
  // -------------------------------------------------------------------------
  function initLightboxEvents() {
    DOM.lightboxClose.addEventListener("click", closeLightbox);
    DOM.lightboxBackdrop.addEventListener("click", closeLightbox);
    DOM.lightboxNext.addEventListener("click", (e) => {
      e.stopPropagation();
      nextImage();
    });
    DOM.lightboxPrev.addEventListener("click", (e) => {
      e.stopPropagation();
      prevImage();
    });

    // Keyboard Shortcuts
    window.addEventListener("keydown", (e) => {
      if (!DOM.lightbox.classList.contains("is-open")) return;

      if (e.key === "Escape") {
        closeLightbox();
      } else if (e.key === "ArrowRight") {
        nextImage();
      } else if (e.key === "ArrowLeft") {
        prevImage();
      }
    });

    // Mobile Swipe Gestures
    let touchStartX = 0;
    let touchEndX = 0;

    DOM.lightbox.addEventListener("touchstart", (e) => {
      touchStartX = e.changedTouches[0].screenX;
    }, { passive: true });

    DOM.lightbox.addEventListener("touchend", (e) => {
      touchEndX = e.changedTouches[0].screenX;
      handleSwipe();
    }, { passive: true });

    function handleSwipe() {
      const threshold = 45;
      if (touchEndX < touchStartX - threshold) {
        nextImage(); // Swiped left -> next
      }
      if (touchEndX > touchStartX + threshold) {
        prevImage(); // Swiped right -> prev
      }
    }
  }

  // -------------------------------------------------------------------------
  // Fallback Dataset (Used seamlessly if opened via file:// protocol without server)
  // -------------------------------------------------------------------------
  function getFallbackDataset() {
    return [
      { id: 1, title: "Misty Alpine Peaks", category: "Nature", url: "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=1200&q=80" },
      { id: 2, title: "Neon Drizzle in Shinjuku", category: "Street", url: "https://images.unsplash.com/photo-1514565131-fce0801e5785?auto=format&fit=crop&w=1000&q=80" },
      { id: 3, title: "Golden Hour Silhouette", category: "Portrait", url: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=1000&q=80" },
      { id: 4, title: "Geometric Concrete Facade", category: "Architecture", url: "https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?auto=format&fit=crop&w=1200&q=80" },
      { id: 5, title: "Emerald Forest Stream", category: "Nature", url: "https://images.unsplash.com/photo-1448375240586-882707db888b?auto=format&fit=crop&w=1200&q=80" },
      { id: 6, title: "Monochrome Studio Glance", category: "Portrait", url: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=1000&q=80" },
      { id: 7, title: "Cobblestone Rain Reflections", category: "Street", url: "https://images.unsplash.com/photo-1519501025264-65ba15a82390?auto=format&fit=crop&w=1200&q=80" },
      { id: 8, title: "Spiral Bauhaus Stairway", category: "Architecture", url: "https://images.unsplash.com/photo-1513694203232-719a280e022f?auto=format&fit=crop&w=1200&q=80" },
      { id: 9, title: "Dolomite Sunrise Glow", category: "Nature", url: "https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?auto=format&fit=crop&w=1200&q=80" },
      { id: 10, title: "Midnight Cyclist in London", category: "Street", url: "https://images.unsplash.com/photo-1509114397022-ed747cca3f65?auto=format&fit=crop&w=1000&q=80" },
      { id: 11, title: "Freckles & Natural Sunlight", category: "Portrait", url: "https://images.unsplash.com/photo-1517841905240-472988babdf9?auto=format&fit=crop&w=1000&q=80" },
      { id: 12, title: "Futuristic Glass Pavilion", category: "Architecture", url: "https://images.unsplash.com/photo-1487958449943-2429e8be8625?auto=format&fit=crop&w=1200&q=80" },
      { id: 13, title: "Nordic Winter Solitude", category: "Nature", url: "https://images.unsplash.com/photo-1491555103944-7c647fd857e6?auto=format&fit=crop&w=1200&q=80" },
      { id: 14, title: "Vibrant Havana Alley", category: "Street", url: "https://images.unsplash.com/photo-1506784983877-45594efa4cbe?auto=format&fit=crop&w=1200&q=80" },
      { id: 15, title: "Expression in Shadows", category: "Portrait", url: "https://images.unsplash.com/photo-1524504388940-b1c1722653e1?auto=format&fit=crop&w=1000&q=80" },
      { id: 16, title: "Cantilever Sky Bridge", category: "Architecture", url: "https://images.unsplash.com/photo-1503387762-592deb58ef4e?auto=format&fit=crop&w=1200&q=80" }
    ];
  }

  // -------------------------------------------------------------------------
  // Loading / START screen (audio unlock + swarm handoff)
  // -------------------------------------------------------------------------
  function initLoadingScreen() {
    const loadingScreenEl = document.getElementById("loadingScreen");
    const loadingBarFillEl = document.getElementById("loadingBarFill");
    const loadingPercentEl = document.getElementById("loadingPercent");
    const loadingStatusTextEl = document.getElementById("loadingStatusText");
    const loadingStartBtnEl = document.getElementById("loadingStartBtn");
    const loadingHintEl = document.getElementById("loadingHint");

    if (!loadingScreenEl) {
      state.enterRequested = true;
      tryStartSwarm();
      return;
    }

    let loadProgressVal = 0;
    let loadProgressTimer = null;
    let loadingHidden = false;

    function setLoadProgress(p) {
      loadProgressVal = Math.max(loadProgressVal, Math.min(100, p));
      if (loadingBarFillEl) loadingBarFillEl.style.width = `${loadProgressVal}%`;
      if (loadingPercentEl) loadingPercentEl.textContent = `${Math.round(loadProgressVal)}%`;
    }

    function startLoadProgress() {
      loadProgressTimer = setInterval(() => {
        let next = loadProgressVal + (Math.random() * 6 + 2);
        if (next > 92) next = 92;
        setLoadProgress(next);
      }, 120);
    }

    function enterSite() {
      if (loadingHidden) return;
      loadingHidden = true;
      if (loadProgressTimer) {
        clearInterval(loadProgressTimer);
        loadProgressTimer = null;
      }
      setLoadProgress(100);
      if (loadingStatusTextEl) loadingStatusTextEl.textContent = "SYSTEM READY";

      try {
        if (window.__swarmRebuild && typeof window.__swarmRebuild.unlockAudio === "function") {
          window.__swarmRebuild.unlockAudio();
        }
      } catch (err) { /* ignore */ }

      state.enterRequested = true;
      tryStartSwarm();

      setTimeout(() => {
        loadingScreenEl.classList.add("is-hidden");
        loadingScreenEl.setAttribute("aria-busy", "false");
      }, 260);
    }

    function markReady() {
      if (loadProgressTimer) {
        clearInterval(loadProgressTimer);
        loadProgressTimer = null;
      }
      setLoadProgress(100);
      if (loadingStatusTextEl) loadingStatusTextEl.textContent = "READY — CLICK TO ENTER";
      if (loadingHintEl) loadingHintEl.textContent = "Click START to enter the site";
      if (loadingStartBtnEl) {
        loadingStartBtnEl.classList.add("is-ready");
        loadingStartBtnEl.disabled = false;
      }
    }

    startLoadProgress();
    if (loadingStartBtnEl) {
      loadingStartBtnEl.addEventListener("click", enterSite);
    }

    const loadFallbackTimer = setTimeout(enterSite, 12000);

    window.addEventListener("load", () => {
      clearTimeout(loadFallbackTimer);
      setTimeout(markReady, 500);
      setTimeout(enterSite, 15000);
    });
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", () => {
    initTheme();
    initLightboxEvents();
    initLoadingScreen();
    loadImages();
  });
})();

