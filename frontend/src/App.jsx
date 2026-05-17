import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import en from './i18n/en.json';
import nl from './i18n/nl.json';
import {
  addRecipeToGroceryList,
  ApiError,
  addWeekPlan,
  autoMatchRecipe,
  buildGroceryList,
  createGroceryList,
  createRecipeImportJob,
  deleteRecipe,
  deleteWeekPlan,
  getGroceryList,
  importProduct,
  listGroceryLists,
  listImportJobs,
  listProducts,
  listRecipes,
  listWeekPlan,
  loadCurrentUser,
  loginAccount,
  matchRecipeIngredient,
  registerAccount,
  updateGroceryListItem,
  waitForRecipeImportJob,
} from './services/api.js';

const dictionaries = { en, nl };
const storageKeys = {
  token: 'boodschappen.token',
  language: 'boodschappen.language',
  theme: 'boodschappen.theme',
};
const dashboardTabs = ['dashboard', 'recipes', 'products', 'jobs', 'week', 'shopping'];
const dayOrder = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

function getStoredValue(key) {
  try {
    return window.localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function setStoredValue(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage errors in private or constrained contexts.
  }
}

function removeStoredValue(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage errors in private or constrained contexts.
  }
}

function getInitialLanguage() {
  const stored = getStoredValue(storageKeys.language);
  if (stored === 'nl' || stored === 'en') {
    return stored;
  }

  const browserLanguage = (window.navigator.language || '').toLowerCase();
  return browserLanguage.startsWith('nl') ? 'nl' : 'en';
}

function getInitialTheme() {
  const stored = getStoredValue(storageKeys.theme);
  if (stored === 'light' || stored === 'dark') {
    return stored;
  }

  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function createEmptyWorkspace() {
  return {
    recipes: [],
    products: [],
    weekPlan: [],
    groceryLists: [],
    activeGroceryList: null,
    jobs: [],
  };
}

function createEmptyAuthForm() {
  return {
    identifier: '',
    email: '',
    username: '',
    password: '',
  };
}

function createEmptyWeekDraft(recipes = []) {
  return {
    day: 'monday',
    recipeId: recipes[0] ? String(recipes[0].id) : '',
    persons: 4,
  };
}

function createRecipeDetailDraft(recipe) {
  return {
    day: 'monday',
    persons: recipe?.base_persons || 4,
  };
}

function replaceTemplate(value, variables) {
  return Object.entries(variables).reduce((result, [key, replacement]) => {
    return result.split(`{${key}}`).join(String(replacement));
  }, value);
}

function localizeDate(value, locale, options) {
  if (!value) {
    return '';
  }

  return new Intl.DateTimeFormat(locale, options).format(new Date(value));
}

function formatPrice(value, locale) {
  if (value === null || value === undefined) {
    return '—';
  }

  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'EUR',
  }).format(value);
}

function formatQuantity(value, locale) {
  const numericValue = Number(value || 0);
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: Number.isInteger(numericValue) ? 0 : 2,
  }).format(numericValue);
}

function formatIngredientName(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }

  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatIngredientMeasure(ingredient, locale) {
  const parts = [];
  const quantity = Number(ingredient?.quantity || 0);

  if (quantity > 0) {
    parts.push(formatQuantity(quantity, locale));
  }

  if (ingredient?.unit) {
    parts.push(ingredient.unit);
  }

  return parts.join(' ');
}

function normalizeExternalUrl(value) {
  const source = String(value || '').trim();

  if (!source) {
    return '';
  }

  try {
    const url = new URL(source);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

function hostFromUrl(value) {
  const source = normalizeExternalUrl(value);
  return source ? new URL(source).hostname.replace(/^www\./, '') : '';
}

function snippet(value, maxLength = 140) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return '';
  }

  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

function textParagraphs(value) {
  return String(value || '')
    .split(/\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function getFocusableElements(container) {
  if (!container) {
    return [];
  }

  return Array.from(container.querySelectorAll(focusableSelector)).filter((element) => {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    if (element.hidden || element.getAttribute('aria-hidden') === 'true') {
      return false;
    }

    const styles = window.getComputedStyle(element);
    return styles.display !== 'none' && styles.visibility !== 'hidden';
  });
}

function weekSummaryText(copy, count) {
  if (!count) {
    return copy.dashboard.week.summaryEmpty;
  }

  return count === 1 ? copy.dashboard.week.summarySingle : copy.dashboard.week.summaryMultiple;
}

function weekPersonsText(copy, count) {
  const safeCount = Math.max(1, Number(count) || 1);
  return replaceTemplate(
    safeCount === 1 ? copy.dashboard.week.personCountSingle : copy.dashboard.week.personCountMultiple,
    { count: safeCount }
  );
}

function recipeStatusText(copy, status) {
  const statusMap = {
    queued: copy.dashboard.recipes.loadingQueued,
    running: copy.dashboard.recipes.loadingRunning,
    succeeded: copy.dashboard.recipes.loadingSucceeded,
    failed: copy.dashboard.recipes.loadingFailed,
  };

  return statusMap[status] || status;
}

function recipeJobStatusLabel(copy, status) {
  return copy.dashboard.recipes.statusLabels[status] || status;
}

function sortJobsByCreatedAt(jobs) {
  return [...jobs].sort((left, right) => {
    const leftTime = Date.parse(String(left?.created_at || ''));
    const rightTime = Date.parse(String(right?.created_at || ''));

    return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
  });
}

function importStatusClass(status) {
  return `import-status--${status}`;
}

function jobStatusClass(status) {
  return `job-status--${status}`;
}

function noticeToneClass(type) {
  if (type === 'success') {
    return 'alert--success';
  }

  if (type === 'warning') {
    return 'alert--warning';
  }

  if (type === 'danger') {
    return 'alert--danger';
  }

  return '';
}

function Field({ id, label, help, optionalLabel, children }) {
  return (
    <div className="field">
      <div className="field-label">
        <label htmlFor={id}>{label}</label>
        {optionalLabel ? <span className="chip">{optionalLabel}</span> : null}
      </div>
      {children}
      {help ? <div className="field-help">{help}</div> : null}
    </div>
  );
}

function NoticeBanner({ notice }) {
  if (!notice || !notice.text) {
    return null;
  }

  return <div className={`alert ${noticeToneClass(notice.type)}`}>{notice.text}</div>;
}

function ImageOrFallback({
  src,
  alt,
  fallback,
  className,
  fallbackClassName,
  interactive = false,
  onClick,
}) {
  const [broken, setBroken] = useState(false);

  if (src && !broken) {
    const handleKeyDown = interactive && onClick
      ? (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick();
        }
      }
      : undefined;

    return (
      <img
        src={src}
        alt={alt}
        className={className}
        onError={() => setBroken(true)}
        onClick={interactive ? onClick : undefined}
        onKeyDown={handleKeyDown}
        role={interactive ? 'button' : undefined}
        tabIndex={interactive ? 0 : undefined}
        aria-label={interactive ? alt : undefined}
      />
    );
  }

  return <div className={fallbackClassName || className}>{fallback}</div>;
}

function SectionHeader({ title, copy, note, actions }) {
  return (
    <div className="section-head">
      <div className="section-title-group">
        <h2 className="section-title">{title}</h2>
        {copy ? <p className="section-copy">{copy}</p> : null}
        {note ? <span className="section-note">{note}</span> : null}
      </div>
      {actions ? <div className="panel-actions">{actions}</div> : null}
    </div>
  );
}

function OperationStatePanel({ state, loadingTitle, loadingCopy, successTitle, errorTitle, meta }) {
  if (!state || state.status === 'idle') {
    return null;
  }

  const isLoading = state.status === 'queued' || state.status === 'running';
  if (isLoading) {
    return (
      <div className="loading-card">
        <div className="spinner" />
        <div className="progress-stack">
          <strong>{loadingTitle}</strong>
          <p className="helper-copy">{loadingCopy}</p>
          <div className="meta-row">
            <span className={`import-status ${importStatusClass(state.status)}`}>{state.text}</span>
            {state.sourceUrl ? <span className="chip chip--accent">{hostFromUrl(state.sourceUrl)}</span> : null}
          </div>
          <div className="progress-line" />
          <div className="progress-line" />
          <div className="progress-line" />
        </div>
      </div>
    );
  }

  return (
    <div className={`alert ${state.status === 'failed' ? 'alert--danger' : 'alert--success'}`}>
      <strong>{state.status === 'failed' ? errorTitle : successTitle}</strong>
      <p className="helper-copy">{state.text}</p>
      {meta ? <div className="meta-row">{meta}</div> : null}
    </div>
  );
}

function ShellTopBar({
  copy,
  lang,
  theme,
  userLabel,
  onBrandClick,
  onLangChange,
  onThemeToggle,
  actions,
  mobileNavigation,
  mode = 'app',
}) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobileMenuEnabled, setMobileMenuEnabled] = useState(() => {
    return typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(max-width: 768px)').matches : false;
  });
  const shellRef = useRef(null);
  const themeToggleLabel = theme === 'dark' ? copy.common.light : copy.common.dark;

  useEffect(() => {
    if (!mobileMenuOpen || !mobileMenuEnabled) {
      return undefined;
    }

    function handlePointerDown(event) {
      const target = event.target;
      if (shellRef.current && target instanceof Node && !shellRef.current.contains(target)) {
        setMobileMenuOpen(false);
      }
    }

    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        setMobileMenuOpen(false);
      }
    }

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [mobileMenuEnabled, mobileMenuOpen]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) {
      return undefined;
    }

    const mediaQuery = window.matchMedia('(max-width: 768px)');

    function handleMediaChange(event) {
      setMobileMenuEnabled(event.matches);
      if (!event.matches) {
        setMobileMenuOpen(false);
      }
    }

    setMobileMenuEnabled(mediaQuery.matches);

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleMediaChange);

      return () => {
        mediaQuery.removeEventListener('change', handleMediaChange);
      };
    }

    mediaQuery.addListener(handleMediaChange);

    return () => {
      mediaQuery.removeListener(handleMediaChange);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    const shellElement = shellRef.current;
    const screenElement = shellElement?.closest('.screen-shell');
    if (!shellElement || !screenElement) {
      return undefined;
    }

    function syncShellOffsets() {
      const styles = window.getComputedStyle(shellElement);
      const top = Number.parseFloat(styles.top) || 0;
      const marginBottom = Number.parseFloat(styles.marginBottom) || 0;
      const height = shellElement.getBoundingClientRect().height;
      const stickyOffset = mode === 'app' ? top + height + marginBottom : 12;

      screenElement.style.setProperty('--shell-topbar-height', `${Math.ceil(height)}px`);
      screenElement.style.setProperty('--shell-sticky-offset', `${Math.ceil(stickyOffset)}px`);
    }

    syncShellOffsets();

    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(syncShellOffsets) : null;
    resizeObserver?.observe(shellElement);
    window.addEventListener('resize', syncShellOffsets);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', syncShellOffsets);
      screenElement.style.removeProperty('--shell-topbar-height');
      screenElement.style.removeProperty('--shell-sticky-offset');
    };
  }, [mode]);

  function closeMobileMenu() {
    setMobileMenuOpen(false);
  }

  function handleBrandClick() {
    closeMobileMenu();
    onBrandClick();
  }

  function handleLanguageChange(nextLang) {
    return () => {
      closeMobileMenu();
      onLangChange(nextLang);
    };
  }

  function handleThemeClick() {
    closeMobileMenu();
    onThemeToggle();
  }

  function handleActionClick(action) {
    return () => {
      closeMobileMenu();
      action.onClick();
    };
  }

  function handleNavigationClick(item) {
    return () => {
      closeMobileMenu();
      item.onClick();
    };
  }

  return (
    <header className={`page-topbar page-topbar--${mode}`} ref={shellRef}>
      <button type="button" className="button button--ghost brand" onClick={handleBrandClick}>
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-copy">
          <span className="brand-name">{copy.brand.name}</span>
          <span className="brand-tagline">{copy.brand.tagline}</span>
        </span>
      </button>
      {mobileMenuEnabled ? (
        <>
          <button
            type="button"
            className={`button button--secondary nav-hamburger ${mobileMenuOpen ? 'is-open' : ''}`}
            onClick={() => setMobileMenuOpen((current) => !current)}
            aria-expanded={mobileMenuOpen}
            aria-controls="nav-drawer"
            aria-label={mobileMenuOpen ? copy.common.menuClose : copy.common.menuOpen}
          >
            <span className="nav-hamburger-lines" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </button>
          <div id="nav-drawer" className={`nav-drawer ${mobileMenuOpen ? 'is-open' : ''}`} aria-hidden={!mobileMenuOpen}>
            <div className="nav-drawer-panel">
              {mobileNavigation ? (
                <div className="nav-drawer-section">
                  <span className="nav-drawer-label">{mobileNavigation.label}</span>
                  <div className="nav-drawer-actions">
                    {mobileNavigation.items.map((item) => (
                      <button
                        key={item.key}
                        type="button"
                        className={`button button--pill nav-drawer-item ${item.active ? 'button--active' : 'button--secondary'}`}
                        onClick={handleNavigationClick(item)}
                        aria-pressed={item.active}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="nav-drawer-section">
                <span className="nav-drawer-label">{copy.common.language}</span>
                <div className="nav-drawer-row">
                  <button
                    type="button"
                    className={`button button--pill nav-drawer-item ${lang === 'nl' ? 'button--active' : 'button--secondary'}`}
                    onClick={handleLanguageChange('nl')}
                    aria-pressed={lang === 'nl'}
                  >
                    NL
                  </button>
                  <button
                    type="button"
                    className={`button button--pill nav-drawer-item ${lang === 'en' ? 'button--active' : 'button--secondary'}`}
                    onClick={handleLanguageChange('en')}
                    aria-pressed={lang === 'en'}
                  >
                    EN
                  </button>
                </div>
              </div>
              <div className="nav-drawer-section">
                <span className="nav-drawer-label">{copy.common.theme}</span>
                <button
                  type="button"
                  className="button button--secondary nav-drawer-item"
                  onClick={handleThemeClick}
                >
                  {themeToggleLabel}
                </button>
              </div>
              {userLabel ? (
                <div className="nav-drawer-section nav-drawer-section--account">
                  <span className="nav-drawer-label">{copy.common.account}</span>
                  <div className="nav-drawer-account">{userLabel}</div>
                </div>
              ) : null}
              <div className="nav-drawer-actions">
                {actions.map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    className={`button nav-drawer-item ${action.variant === 'primary' ? 'button--primary' : 'button--secondary'}`}
                    onClick={handleActionClick(action)}
                    disabled={action.disabled}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className="toolbar">
          <div className="toolbar-group">
            <span className="toolbar-label">{copy.common.language}</span>
            <button
              type="button"
              className={`button button--pill ${lang === 'nl' ? 'button--active' : 'button--secondary'}`}
              onClick={handleLanguageChange('nl')}
              aria-pressed={lang === 'nl'}
            >
              NL
            </button>
            <button
              type="button"
              className={`button button--pill ${lang === 'en' ? 'button--active' : 'button--secondary'}`}
              onClick={handleLanguageChange('en')}
              aria-pressed={lang === 'en'}
            >
              EN
            </button>
          </div>
          <div className="toolbar-group">
            <span className="toolbar-label">{copy.common.theme}</span>
            <button type="button" className="button button--secondary button--pill" onClick={handleThemeClick}>
              {themeToggleLabel}
            </button>
          </div>
          {userLabel ? <span className="chip chip--accent">{userLabel}</span> : null}
          <div className="inline-actions">
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                className={`button ${action.variant === 'primary' ? 'button--primary' : 'button--secondary'}`}
                onClick={handleActionClick(action)}
                disabled={action.disabled}
              >
                {action.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </header>
  );
}

function BootScreen({ copy }) {
  return (
    <div className="app-shell">
      <section className="surface surface--soft hero-shell hero fade-in">
        <div className="hero-grid">
          <span className="eyebrow">{copy.common.loading}</span>
          <h1 className="hero-title">{copy.brand.name}</h1>
          <p className="hero-subtitle">{copy.brand.tagline}</p>
          <div className="loading-card">
            <div className="spinner" />
            <div className="progress-stack">
              <strong>{copy.common.loading}</strong>
              <p className="helper-copy">{copy.landing.subtitle}</p>
              <div className="progress-line" />
              <div className="progress-line" />
              <div className="progress-line" />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function SignedInCard({ copy, sessionUser, onOpenDashboard }) {
  return (
    <div className="auth-heading">
      <span className="eyebrow">{copy.nav.dashboard}</span>
      <h2 className="auth-title">{replaceTemplate(copy.dashboard.welcome, { username: sessionUser.username })}</h2>
      <p className="auth-copy">{copy.landing.authCopy}</p>
      <div className="notice-stack">
        <span className="chip chip--accent">{sessionUser.email}</span>
        <span className="chip">{copy.landing.authHint}</span>
        <button type="button" className="button button--primary button--block" onClick={onOpenDashboard}>
          {copy.nav.openDashboard}
        </button>
      </div>
    </div>
  );
}

function AuthPanel({
  copy,
  authMode,
  onChangeMode,
  authForm,
  onFieldChange,
  authMessage,
  authBusy,
  onLoginSubmit,
  onRegisterSubmit,
}) {
  return (
    <>
      <div className="auth-heading">
        <span className="eyebrow">{copy.nav.signIn}</span>
        <h2 className="auth-title">{authMode === 'login' ? copy.auth.loginTitle : copy.auth.registerTitle}</h2>
        <p className="auth-copy">{copy.landing.authCopy}</p>
      </div>
      <div className="segmented-control" role="tablist" aria-label={copy.nav.signIn}>
        <button
          type="button"
          role="tab"
          aria-selected={authMode === 'login'}
          className={`segmented-button ${authMode === 'login' ? 'is-active' : ''}`}
          onClick={() => onChangeMode('login')}
          disabled={authBusy}
        >
          {copy.auth.tabs.login}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={authMode === 'register'}
          className={`segmented-button ${authMode === 'register' ? 'is-active' : ''}`}
          onClick={() => onChangeMode('register')}
          disabled={authBusy}
        >
          {copy.auth.tabs.register}
        </button>
      </div>
      <p className="helper-copy">{authMode === 'login' ? copy.auth.loginHelper : copy.auth.registerHelper}</p>
      <NoticeBanner notice={authMessage} />
      {authMode === 'login' ? (
        <form className="form-grid" onSubmit={onLoginSubmit}>
          <Field
            id="login-identifier"
            label={copy.auth.labels.identifier}
            help={copy.auth.loginHelper}
          >
            <input
              id="login-identifier"
              className="control"
              autoComplete="username"
              inputMode="text"
              autoCapitalize="none"
              spellCheck={false}
              placeholder={copy.auth.placeholders.identifier}
              value={authForm.identifier}
              onChange={(event) => onFieldChange('identifier', event.target.value)}
              disabled={authBusy}
              required
            />
          </Field>
          <Field id="login-password" label={copy.auth.labels.password}>
            <input
              id="login-password"
              type="password"
              className="control"
              autoComplete="current-password"
              placeholder={copy.auth.placeholders.password}
              value={authForm.password}
              onChange={(event) => onFieldChange('password', event.target.value)}
              disabled={authBusy}
              minLength={8}
              required
            />
          </Field>
          <button type="submit" className="button button--primary button--block" disabled={authBusy}>
            {authBusy ? copy.common.loading : copy.auth.buttons.login}
          </button>
        </form>
      ) : (
        <form className="form-grid" onSubmit={onRegisterSubmit}>
          <Field
            id="register-username"
            label={copy.auth.labels.username}
            optionalLabel={copy.common.optional}
            help={copy.auth.registerHelper}
          >
            <input
              id="register-username"
              className="control"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              placeholder={copy.auth.placeholders.username}
              value={authForm.username}
              onChange={(event) => onFieldChange('username', event.target.value)}
              disabled={authBusy}
            />
          </Field>
          <Field id="register-email" label={copy.auth.labels.email}>
            <input
              id="register-email"
              className="control"
              type="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              placeholder={copy.auth.placeholders.email}
              value={authForm.email}
              onChange={(event) => onFieldChange('email', event.target.value)}
              disabled={authBusy}
              required
            />
          </Field>
          <Field id="register-password" label={copy.auth.labels.password}>
            <input
              id="register-password"
              type="password"
              className="control"
              autoComplete="new-password"
              placeholder={copy.auth.placeholders.password}
              value={authForm.password}
              onChange={(event) => onFieldChange('password', event.target.value)}
              disabled={authBusy}
              minLength={8}
              required
            />
          </Field>
          <button type="submit" className="button button--primary button--block" disabled={authBusy}>
            {authBusy ? copy.common.loading : copy.auth.buttons.register}
          </button>
        </form>
      )}
    </>
  );
}

function LandingScreen({
  copy,
  lang,
  theme,
  onLangChange,
  onThemeToggle,
  onOpenTutorial,
  onOpenDashboard,
  onBrandClick,
  sessionUser,
  authMode,
  onChangeAuthMode,
  authForm,
  onAuthFieldChange,
  authMessage,
  authBusy,
  onLoginSubmit,
  onRegisterSubmit,
  authPanelRef,
}) {
  const heroChips = copy.landing.principles.map((principle, index) => ({
    index: index + 1,
    title: principle.title,
  }));
  const actions = [
    {
      label: copy.nav.tutorial,
      onClick: onOpenTutorial,
      variant: 'secondary',
    },
    {
      label: sessionUser ? copy.nav.dashboard : copy.landing.ctaPrimary,
      onClick: onOpenDashboard,
      variant: 'primary',
    },
  ];

  return (
    <div className="screen-shell screen-shell--landing stack fade-in">
      <ShellTopBar
        copy={copy}
        lang={lang}
        theme={theme}
        userLabel={sessionUser ? sessionUser.username : ''}
        onBrandClick={onBrandClick}
        onLangChange={onLangChange}
        onThemeToggle={onThemeToggle}
        actions={actions}
        mode="landing"
      />
      <div className="landing-layout">
        <section className="surface surface--soft hero hero-shell">
          <div className="hero-grid">
            <span className="eyebrow">{copy.landing.eyebrow}</span>
            <h1 className="hero-title">{copy.landing.title}</h1>
            <p className="hero-subtitle">{copy.landing.subtitle}</p>
            <div className="action-row">
              <button type="button" className="button button--primary" onClick={onOpenDashboard}>
                {copy.landing.ctaPrimary}
              </button>
              <button type="button" className="button button--secondary" onClick={onOpenTutorial}>
                {copy.landing.ctaSecondary}
              </button>
            </div>
            <div className="inline-actions">
              {heroChips.map((chip) => (
                <span key={chip.title} className="chip chip--accent">
                  {chip.index}. {chip.title}
                </span>
              ))}
            </div>
            <span className="section-note">{copy.landing.authHint}</span>
          </div>
        </section>
        <section ref={authPanelRef} className="surface auth-card">
          {sessionUser ? (
            <SignedInCard copy={copy} sessionUser={sessionUser} onOpenDashboard={onOpenDashboard} />
          ) : (
            <AuthPanel
              copy={copy}
              authMode={authMode}
              onChangeMode={onChangeAuthMode}
              authForm={authForm}
              onFieldChange={onAuthFieldChange}
              authMessage={authMessage}
              authBusy={authBusy}
              onLoginSubmit={onLoginSubmit}
              onRegisterSubmit={onRegisterSubmit}
            />
          )}
        </section>
      </div>
      <section className="surface surface-pad">
        <SectionHeader title={copy.landing.principlesTitle} />
        <div className="feature-grid">
          {copy.landing.principles.map((principle, index) => (
            <article key={principle.title} className="surface surface--compact feature-card">
              <div className="feature-number">{index + 1}</div>
              <h3 className="feature-title">{principle.title}</h3>
              <p className="feature-copy">{principle.description}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="surface surface-pad">
        <SectionHeader title={copy.landing.workflowTitle} />
        <div className="feature-grid">
          {copy.landing.workflow.map((item, index) => (
            <article key={item.title} className="surface surface--compact feature-card">
              <div className="feature-number">{index + 1}</div>
              <h3 className="feature-title">{item.title}</h3>
              <p className="feature-copy">{item.description}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function RecipeDetailDialog({
  copy,
  recipe,
  locale,
  products,
  groceryLists,
  onClose,
  onAddToWeek,
  onAddToGroceryList,
  onCreateGroceryList,
  onAutoMatchRecipe,
  onMatchIngredient,
  onDeleteRecipe,
  returnFocusRef,
}) {
  const dialogRef = useRef(null);
  const titleRef = useRef(null);
  const [planDraft, setPlanDraft] = useState(() => createRecipeDetailDraft(recipe));
  const [planningBusy, setPlanningBusy] = useState(false);
  const [planningNotice, setPlanningNotice] = useState({ type: '', text: '' });
  const [showAllIngredients, setShowAllIngredients] = useState(false);
  const [showAllInstructions, setShowAllInstructions] = useState(false);
  const [matchingBusy, setMatchingBusy] = useState(false);
  const [matchingNotice, setMatchingNotice] = useState({ type: '', text: '' });
  const [matchDrafts, setMatchDrafts] = useState({});
  const [openIngredientMatchId, setOpenIngredientMatchId] = useState(null);
  const [listOverlayOpen, setListOverlayOpen] = useState(false);
  const [listBusy, setListBusy] = useState(false);
  const [listNotice, setListNotice] = useState({ type: '', text: '' });
  const [listDraft, setListDraft] = useState(() => ({
    selectedListId: groceryLists[0] ? String(groceryLists[0].id) : '',
    newListName: '',
  }));
  const [deleteBusy, setDeleteBusy] = useState(false);
  const titleId = `recipe-detail-title-${recipe.id}`;
  const leadId = `recipe-detail-lead-${recipe.id}`;
  const ingredientsRegionId = `recipe-detail-ingredients-${recipe.id}`;
  const instructionsRegionId = `recipe-detail-instructions-${recipe.id}`;
  const descriptionParagraphs = textParagraphs(recipe.description);
  const instructionSteps = textParagraphs(recipe.instructions);
  const canToggleIngredients = recipe.ingredients.length > 3;
  const canToggleInstructions = instructionSteps.length > 3;
  const visibleIngredients = showAllIngredients ? recipe.ingredients : recipe.ingredients.slice(0, 3);
  const visibleInstructions = showAllInstructions ? instructionSteps : instructionSteps.slice(0, 3);
  const sourceUrl = normalizeExternalUrl(recipe.source_url);
  const sourceHost = hostFromUrl(sourceUrl);
  const recipeLead = descriptionParagraphs[0] || sourceHost || snippet(recipe.instructions, 180);
  const pantryIngredients = recipe.ingredients.filter(
    (ingredient) => !ingredient.product_id && ingredient.requires_product === false
  );
  const pantryIngredientSummary = pantryIngredients
    .map((ingredient) => {
      const label = formatIngredientName(ingredient.name || ingredient.normalized_name || ingredient.raw_text);
      const measure = formatIngredientMeasure(ingredient, locale);
      return measure ? `${label} (${measure})` : label;
    })
    .join(', ');
  const ingredientsToggleLabel = `${showAllIngredients ? copy.common.showLess : copy.common.showMore}...`;
  const instructionsToggleLabel = `${showAllInstructions ? copy.common.showLess : copy.common.showMore}...`;

  useEffect(() => {
    setPlanDraft(createRecipeDetailDraft(recipe));
    setPlanningBusy(false);
    setPlanningNotice({ type: '', text: '' });
    setShowAllIngredients(false);
    setShowAllInstructions(false);
    setMatchingBusy(false);
    setMatchingNotice({ type: '', text: '' });
    setMatchDrafts({});
    setOpenIngredientMatchId(null);
    setListOverlayOpen(false);
    setListBusy(false);
    setListNotice({ type: '', text: '' });
    setListDraft({
      selectedListId: groceryLists[0] ? String(groceryLists[0].id) : '',
      newListName: '',
    });
    setDeleteBusy(false);
  }, [groceryLists, recipe.id, recipe.base_persons]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const dialogElement = dialogRef.current;

    document.body.style.overflow = 'hidden';
    titleRef.current?.focus();

    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== 'Tab' || !dialogElement) {
        return;
      }

      const focusableElements = getFocusableElements(dialogElement);
      if (!focusableElements.length) {
        event.preventDefault();
        titleRef.current?.focus();
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;

      if (event.shiftKey) {
        if (activeElement === firstElement || activeElement === titleRef.current) {
          event.preventDefault();
          lastElement.focus();
        }

        return;
      }

      if (activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    }

    dialogElement?.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      dialogElement?.removeEventListener('keydown', handleKeyDown);

      if (returnFocusRef?.current instanceof HTMLElement && returnFocusRef.current.isConnected) {
        returnFocusRef.current.focus();
      }
    };
  }, [onClose, recipe.id, returnFocusRef]);

  async function handlePlanSubmit(event) {
    event.preventDefault();
    const nextPersons = Math.max(1, Number(planDraft.persons) || 1);

    if (!recipe.is_fully_matched) {
      setPlanningNotice({
        type: 'danger',
        text: copy.dashboard.recipes.matchRequired,
      });
      return;
    }

    setPlanningBusy(true);
    setPlanningNotice({ type: '', text: '' });

    try {
      await onAddToWeek(recipe.id, {
        day: planDraft.day,
        persons: nextPersons,
      });
      setPlanDraft((current) => ({
        ...current,
        persons: nextPersons,
      }));
      setPlanningNotice({
        type: 'success',
        text: copy.dashboard.recipes.addedToWeek,
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        return;
      }

      setPlanningNotice({
        type: 'danger',
        text: error.message || copy.dashboard.week.addError,
      });
    } finally {
      setPlanningBusy(false);
    }
  }

  function updateListDraft(field, value) {
    setListDraft((current) => ({
      ...current,
      [field]: value,
    }));
  }

  async function handleAddToList() {
    const nextPersons = Math.max(1, Number(planDraft.persons) || 1);

    if (!recipe.is_fully_matched) {
      setListNotice({
        type: 'danger',
        text: copy.dashboard.recipes.matchRequired,
      });
      return;
    }

    const nextListName = listDraft.newListName.trim();
    let targetListId = listDraft.selectedListId;
    if (!targetListId && !nextListName) {
      setListNotice({ type: 'warning', text: copy.dashboard.recipes.listChoiceRequired });
      return;
    }

    setListBusy(true);
    setListNotice({ type: '', text: '' });

    try {
      if (nextListName) {
        const createdList = await onCreateGroceryList(nextListName);
        targetListId = String(createdList.id);
      }

      await onAddToGroceryList(Number(targetListId), {
        recipe_id: recipe.id,
        persons: nextPersons,
      });
      setListDraft((current) => ({
        ...current,
        selectedListId: String(targetListId),
        newListName: '',
      }));
      setListNotice({ type: 'success', text: copy.dashboard.recipes.addedToList });
      setListOverlayOpen(false);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        return;
      }

      setListNotice({
        type: 'danger',
        text: error.message || copy.dashboard.recipes.addToListFailed,
      });
    } finally {
      setListBusy(false);
    }
  }

  function updateMatchDraft(ingredientId, field, value) {
    setMatchDrafts((current) => ({
      ...current,
      [ingredientId]: {
        productId: current[ingredientId]?.productId || '',
        ahUrl: current[ingredientId]?.ahUrl || '',
        [field]: value,
      },
    }));
  }

  function handleReviewBasicIngredients() {
    if (!pantryIngredients.length) {
      return;
    }

    setListOverlayOpen(false);
    setShowAllIngredients(true);
    setOpenIngredientMatchId(pantryIngredients[0].id);
  }

  async function handleAutoMatch() {
    setMatchingBusy(true);
    setMatchingNotice({ type: '', text: '' });

    try {
      await onAutoMatchRecipe(recipe.id);
      setMatchingNotice({ type: 'success', text: copy.dashboard.recipes.autoMatchDone });
    } catch (error) {
      setMatchingNotice({ type: 'danger', text: error.message || copy.dashboard.recipes.autoMatchFailed });
    } finally {
      setMatchingBusy(false);
    }
  }

  async function handleManualMatch(ingredient) {
    const draft = matchDrafts[ingredient.id] || { productId: '', ahUrl: '' };
    const payload = {};
    if (draft.productId) {
      payload.product_id = Number(draft.productId);
    } else if (draft.ahUrl?.trim()) {
      payload.ah_url = draft.ahUrl.trim();
    } else {
      setMatchingNotice({ type: 'warning', text: copy.dashboard.recipes.matchPickRequired });
      return;
    }

    setMatchingBusy(true);
    setMatchingNotice({ type: '', text: '' });

    try {
      await onMatchIngredient(recipe.id, ingredient.id, payload);
      setMatchingNotice({ type: 'success', text: copy.dashboard.recipes.matchSaved });
      setOpenIngredientMatchId(null);
      setMatchDrafts((current) => ({
        ...current,
        [ingredient.id]: { productId: '', ahUrl: '' },
      }));
    } catch (error) {
      setMatchingNotice({ type: 'danger', text: error.message || copy.dashboard.recipes.matchSaveFailed });
    } finally {
      setMatchingBusy(false);
    }
  }

  async function handleDeleteRecipe() {
    if (!window.confirm(copy.dashboard.recipes.deleteConfirm)) {
      return;
    }

    setDeleteBusy(true);
    try {
      await onDeleteRecipe(recipe.id);
      onClose();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        return;
      }

      setPlanningNotice({
        type: 'danger',
        text: error.message || copy.dashboard.recipes.deleteFailed,
      });
    } finally {
      setDeleteBusy(false);
    }
  }

  const dialog = (
    <div className="recipe-detail-overlay" onClick={onClose}>
      <section
        ref={dialogRef}
        className="surface recipe-detail-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={recipeLead ? leadId : undefined}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="recipe-detail-shell">
          <div className="recipe-detail-handle" aria-hidden="true" />
          <div className="recipe-detail-header">
            <div className="recipe-detail-heading">
              <span className="eyebrow">{copy.dashboard.recipes.viewRecipe}</span>
              <h2 id={titleId} ref={titleRef} tabIndex={-1} className="recipe-detail-title">{recipe.name}</h2>
              {recipeLead ? (
                <p id={leadId} className="recipe-detail-lead">
                  {recipeLead}
                </p>
              ) : null}
            </div>
            <div className="recipe-detail-actions">
              {sourceUrl ? (
                <a className="button button--secondary recipe-detail-source" href={sourceUrl} target="_blank" rel="noreferrer">
                  {copy.dashboard.recipes.openSource}
                </a>
              ) : null}
              <button type="button" className="button button--ghost recipe-detail-close" onClick={onClose}>
                {copy.common.close}
              </button>
            </div>
          </div>

          <div className="recipe-detail-layout">
            <section className="detail-card detail-card--ingredient-pane">
              <div className="recipe-detail-media-stack">
                <ImageOrFallback
                  src={recipe.image}
                  alt={recipe.name}
                  fallback={<span>{recipe.name}</span>}
                  className="recipe-detail-cover recipe-detail-cover--image"
                  fallbackClassName="recipe-thumb recipe-detail-cover recipe-detail-cover--fallback"
                />
                <div className="recipe-detail-meta">
                  <span className="chip chip--accent">
                    {recipe.base_persons} {copy.dashboard.recipes.basePersonsLabel}
                  </span>
                  <span className="chip">
                    {recipe.ingredients.length} {copy.dashboard.recipes.ingredientsLabel}
                  </span>
                  {sourceHost ? <span className="chip">{sourceHost}</span> : null}
                  <span className="chip">{localizeDate(recipe.created_at, locale, { dateStyle: 'medium' })}</span>
                </div>
              </div>

              <div className="panel-heading">
                <h3 className="panel-title">{copy.dashboard.recipes.ingredientsTitle}</h3>
                <button
                  type="button"
                  className="button button--secondary detail-toggle"
                  onClick={handleAutoMatch}
                  disabled={matchingBusy}
                >
                  {matchingBusy ? (
                    <span className="button-content--loading">
                      <span className="button-inline-spinner" aria-hidden="true" />
                      <span>{copy.dashboard.recipes.autoMatchButton}</span>
                    </span>
                  ) : copy.dashboard.recipes.autoMatchButton}
                </button>
              </div>
              <NoticeBanner notice={matchingNotice} />
              <div id={ingredientsRegionId} className="recipe-detail-ingredients">
                {visibleIngredients.map((ingredient, index) => {
                  const ingredientLabel = formatIngredientName(
                    ingredient.name || ingredient.normalized_name || ingredient.raw_text
                  );
                  const ingredientMeasure = formatIngredientMeasure(ingredient, locale);
                  const requiresProduct = ingredient.requires_product !== false;

                  return (
                    <div key={`${recipe.id}-ingredient-${index + 1}`} className="recipe-detail-ingredient">
                      <div className="ingredient-match-main">
                        <strong>{ingredientLabel}</strong>
                        {ingredientMeasure ? (
                          <span className="ingredient-measurement">{ingredientMeasure}</span>
                        ) : null}
                        {ingredient.product_id ? (
                          <span className="ingredient-product-name">
                            {copy.dashboard.recipes.productLabel}: {ingredient.product_title}
                          </span>
                        ) : requiresProduct ? (
                          <button
                            type="button"
                            className="ingredient-product-trigger"
                            onClick={() => setOpenIngredientMatchId((current) => (current === ingredient.id ? null : ingredient.id))}
                          >
                            <span>{copy.dashboard.recipes.productLabel}:</span>
                            <span className="ingredient-product-trigger__value">{copy.dashboard.recipes.noMatchLabel}</span>
                          </button>
                        ) : null}
                      </div>
                      {!ingredient.product_id && openIngredientMatchId === ingredient.id ? (
                        <div className="ingredient-match-controls">
                          <select
                            className="select"
                            value={matchDrafts[ingredient.id]?.productId || ''}
                            onChange={(event) => updateMatchDraft(ingredient.id, 'productId', event.target.value)}
                          >
                            <option value="">{copy.dashboard.recipes.matchSelectExisting}</option>
                            {products.map((product) => (
                              <option key={product.id} value={String(product.id)}>
                                {product.title}
                              </option>
                            ))}
                          </select>
                          <input
                            className="control"
                            type="url"
                            inputMode="url"
                            placeholder={copy.dashboard.recipes.matchUrlPlaceholder}
                            value={matchDrafts[ingredient.id]?.ahUrl || ''}
                            onChange={(event) => updateMatchDraft(ingredient.id, 'ahUrl', event.target.value)}
                          />
                          <button
                            type="button"
                            className="button button--secondary"
                            onClick={() => handleManualMatch(ingredient)}
                            disabled={matchingBusy}
                          >
                            {copy.dashboard.recipes.matchButton}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              {canToggleIngredients ? (
                <button
                  type="button"
                  className="button button--secondary detail-toggle detail-toggle--footer"
                  aria-expanded={showAllIngredients}
                  aria-controls={ingredientsRegionId}
                  onClick={() => setShowAllIngredients((current) => !current)}
                >
                  {ingredientsToggleLabel}
                </button>
              ) : null}
            </section>

            <div className="recipe-detail-main-column">
              <section className="detail-card detail-card--planning">
                <div className="section-title-group">
                  <h3 className="panel-title">{copy.dashboard.recipes.planningTitle}</h3>
                  <p className="panel-copy">{copy.dashboard.recipes.planningCopy}</p>
                </div>
                <NoticeBanner notice={planningNotice} />
                <form className="recipe-plan-grid" onSubmit={handlePlanSubmit}>
                  <Field id={`recipe-detail-day-${recipe.id}`} label={copy.dashboard.week.dayLabel}>
                    <select
                      id={`recipe-detail-day-${recipe.id}`}
                      className="select"
                      value={planDraft.day}
                      onChange={(event) => setPlanDraft((current) => ({ ...current, day: event.target.value }))}
                    >
                      {dayOrder.map((day) => (
                        <option key={day} value={day}>
                          {copy.dashboard.week.days[day]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field id={`recipe-detail-persons-${recipe.id}`} label={copy.dashboard.week.personsLabel}>
                    <input
                      id={`recipe-detail-persons-${recipe.id}`}
                      className="control"
                      type="number"
                      min="1"
                      step="1"
                      value={planDraft.persons}
                      onChange={(event) => {
                        const nextValue = event.target.value === '' ? '' : Number(event.target.value);
                        setPlanDraft((current) => ({ ...current, persons: nextValue }));
                      }}
                      required
                    />
                  </Field>
                  <div className="recipe-plan-actions">
                    <button type="submit" className="button button--primary button--block" disabled={planningBusy}>
                      {planningBusy ? copy.common.loading : copy.dashboard.week.button}
                    </button>
                    <button
                      type="button"
                      className="button button--secondary button--block"
                      onClick={() => {
                        setListOverlayOpen((current) => !current);
                        setListNotice({ type: '', text: '' });
                      }}
                      disabled={listBusy}
                    >
                      {copy.dashboard.recipes.addToListButton}
                    </button>
                  </div>
                </form>
                {listOverlayOpen ? (
                  <div className="recipe-list-overlay">
                    <div className="section-title-group">
                      <h4 className="panel-title">{copy.dashboard.recipes.listOverlayTitle}</h4>
                      <p className="panel-copy">{copy.dashboard.recipes.listOverlayCopy}</p>
                    </div>
                    <NoticeBanner notice={listNotice} />
                    {pantryIngredientSummary ? (
                      <div className="recipe-list-basics-note">
                        <strong>{copy.dashboard.recipes.listOverlayBasicIngredientsTitle}</strong>
                        <p className="helper-copy">
                          {replaceTemplate(copy.dashboard.recipes.listOverlayBasicIngredientsCopy, {
                            ingredients: pantryIngredientSummary,
                          })}
                        </p>
                        <p className="helper-copy">{copy.dashboard.recipes.listOverlayBasicIngredientsHint}</p>
                        <button
                          type="button"
                          className="button button--secondary"
                          onClick={handleReviewBasicIngredients}
                        >
                          {copy.dashboard.recipes.listOverlayBasicIngredientsReview}
                        </button>
                      </div>
                    ) : null}
                    {groceryLists.length ? (
                      <Field id={`recipe-list-select-${recipe.id}`} label={copy.dashboard.recipes.listOverlaySelectLabel}>
                        <select
                          id={`recipe-list-select-${recipe.id}`}
                          className="select"
                          value={listDraft.selectedListId}
                          onChange={(event) => updateListDraft('selectedListId', event.target.value)}
                        >
                          <option value="">{copy.dashboard.recipes.listOverlaySelectLabel}</option>
                          {groceryLists.map((list) => (
                            <option key={list.id} value={String(list.id)}>
                              {list.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                    ) : null}
                    <Field
                      id={`recipe-list-create-${recipe.id}`}
                      label={copy.dashboard.recipes.listOverlayCreateLabel}
                      optionalLabel={copy.common.optional}
                    >
                      <input
                        id={`recipe-list-create-${recipe.id}`}
                        className="control"
                        value={listDraft.newListName}
                        placeholder={copy.dashboard.recipes.listOverlayCreatePlaceholder}
                        onChange={(event) => updateListDraft('newListName', event.target.value)}
                      />
                    </Field>
                    <button
                      type="button"
                      className="button button--primary button--block"
                      onClick={handleAddToList}
                      disabled={listBusy}
                    >
                      {listBusy ? copy.common.loading : copy.dashboard.recipes.addToListConfirmButton}
                    </button>
                  </div>
                ) : null}
              </section>

              <section className="detail-card detail-card--instructions">
                <div className="panel-heading">
                  <h3 className="panel-title">{copy.dashboard.recipes.instructionsTitle}</h3>
                </div>
                <ol id={instructionsRegionId} className="recipe-instruction-list">
                  {visibleInstructions.map((step, index) => (
                    <li key={`${recipe.id}-step-${index + 1}`} className="instruction-step">
                      <span className="instruction-index">{index + 1}</span>
                      <span className="instruction-copy">{step}</span>
                    </li>
                  ))}
                </ol>
                {canToggleInstructions ? (
                  <button
                    type="button"
                    className="button button--secondary detail-toggle detail-toggle--footer"
                    aria-expanded={showAllInstructions}
                    aria-controls={instructionsRegionId}
                    onClick={() => setShowAllInstructions((current) => !current)}
                  >
                    {instructionsToggleLabel}
                  </button>
                ) : null}
              </section>
            </div>
          </div>

          <div className="recipe-detail-footer">
            <button
              type="button"
              className="button button--danger button--block"
              onClick={handleDeleteRecipe}
              disabled={deleteBusy}
            >
              {deleteBusy ? copy.common.loading : copy.dashboard.recipes.deleteButton}
            </button>
          </div>
        </div>
      </section>
    </div>
  );

  return createPortal(dialog, document.body);
}

function RecipeCard({ copy, recipe, locale, onOpenDetails }) {
  const ingredientPreview = recipe.ingredients.slice(0, 2);
  const description = recipe.description ? snippet(recipe.description, 160) : snippet(recipe.instructions, 160);
  const sourceUrl = normalizeExternalUrl(recipe.source_url);
  const sourceHost = hostFromUrl(sourceUrl);

  return (
    <article className="surface surface--compact recipe-card">
      <ImageOrFallback
        src={recipe.image}
        alt={recipe.name}
        fallback={<span>{recipe.name}</span>}
        className="recipe-cover"
        fallbackClassName="recipe-thumb"
      />
      <div className="recipe-preview">
        <div className="recipe-intro">
          <div className="recipe-meta">
            <span className="chip chip--accent">
              {recipe.ingredients.length} {copy.dashboard.recipes.ingredientsLabel}
            </span>
            <span className="chip">{recipe.base_persons} {copy.dashboard.recipes.basePersonsLabel}</span>
            <span className={`chip ${recipe.is_fully_matched ? 'chip--success' : 'chip--warning'}`}>
              {recipe.matched_ingredients}/{recipe.total_ingredients} {copy.dashboard.recipes.matchLabel}
            </span>
          </div>
          <h3 className="recipe-title">{recipe.name}</h3>
          {description ? <p className="recipe-copy">{description}</p> : null}
        </div>
        <div className="recipe-meta">
          {sourceHost ? <span className="chip">{sourceHost}</span> : null}
          <span className="chip">{localizeDate(recipe.created_at, locale, { dateStyle: 'medium' })}</span>
        </div>
        {ingredientPreview.length ? (
          <div className="recipe-ingredients-list">
            {ingredientPreview.map((ingredient) => (
              <div key={`${recipe.id}-${ingredient.raw_text}`} className="recipe-ingredient">
                <strong>{ingredient.raw_text}</strong>
                <span>
                  {formatQuantity(ingredient.quantity, locale)} {ingredient.unit}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        <div className="link-row">
          <button
            type="button"
            className="button button--secondary button--pill"
            onClick={(event) => onOpenDetails(recipe.id, event.currentTarget)}
          >
            {copy.dashboard.recipes.viewRecipe}
          </button>
          {sourceUrl ? (
            <a className="link-button" href={sourceUrl} target="_blank" rel="noreferrer">
              {copy.dashboard.recipes.openSource}
            </a>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function ProductCard({ copy, product, locale }) {
  const sourceUrl = normalizeExternalUrl(product.source_url);
  const sourceHost = hostFromUrl(sourceUrl);

  return (
    <article className="surface surface--compact product-card">
      <ImageOrFallback
        src={product.image}
        alt={product.title}
        fallback={<span>{product.title}</span>}
        className="product-cover"
      />
      <div className="product-preview">
        <div className="product-intro">
          <span className="chip chip--accent">{product.ah_id}</span>
          <h3 className="product-title">{product.title}</h3>
          {product.description ? <p className="product-copy">{snippet(product.description, 160)}</p> : null}
        </div>
        <div className="product-meta">
          <span className="chip">{copy.dashboard.products.priceLabel}: {formatPrice(product.price, locale)}</span>
          {product.unit ? <span className="chip">{copy.dashboard.products.unitLabel}: {product.unit}</span> : null}
          {sourceHost ? <span className="chip">{sourceHost}</span> : null}
        </div>
        {sourceHost ? (
          <div className="detail-row">
            <span className="detail-label">{copy.dashboard.products.sourceLabel}</span>
            <span className="detail-value">{sourceHost}</span>
          </div>
        ) : null}
        {sourceUrl ? (
          <div className="link-row">
            <a className="link-button" href={sourceUrl} target="_blank" rel="noreferrer">
              {copy.dashboard.products.openSource}
            </a>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function JobCard({ copy, job, locale, compact = false }) {
  const statusLabel = recipeJobStatusLabel(copy, job.status);
  const sourceText = String(job.source_url || '').trim();
  const sourceHost = hostFromUrl(job.source_url);
  const sourceTitle = sourceHost || sourceText;

  return (
    <article className={`surface surface--compact job-card ${compact ? 'job-card--compact' : ''}`}>
      <div className="job-meta">
        <span className={`job-status ${jobStatusClass(job.status)}`}>{statusLabel}</span>
        <span className="chip">{localizeDate(job.created_at, locale, { dateStyle: 'medium', timeStyle: 'short' })}</span>
      </div>
      {sourceTitle ? <h3 className="job-title">{sourceTitle}</h3> : null}
      {sourceText && sourceText !== sourceTitle ? <p className="job-copy">{sourceText}</p> : null}
      <div className="job-details">
        {job.recipe_id ? (
          <div className="detail-row">
            <span className="detail-label">{copy.dashboard.recipes.linkedRecipeLabel}</span>
            <span className="detail-value">#{job.recipe_id}</span>
          </div>
        ) : null}
        {job.error ? <div className="alert alert--danger">{job.error}</div> : null}
      </div>
    </article>
  );
}

function RecipesSection({
  copy,
  workspace,
  locale,
  recipeUrl,
  onRecipeUrlChange,
  recipeImportState,
  onImportRecipe,
  onAddRecipeToWeek,
  onAddRecipeToShoppingList,
  onCreateShoppingList,
  onAutoMatchRecipe,
  onMatchIngredient,
  onDeleteRecipe,
}) {
  const [selectedRecipeId, setSelectedRecipeId] = useState(null);
  const detailTriggerRef = useRef(null);
  const selectedRecipe = workspace.recipes.find((recipe) => recipe.id === selectedRecipeId) || null;

  useEffect(() => {
    if (selectedRecipeId && !workspace.recipes.some((recipe) => recipe.id === selectedRecipeId)) {
      setSelectedRecipeId(null);
    }
  }, [selectedRecipeId, workspace.recipes]);

  function handleOpenDetails(recipeId, triggerElement) {
    detailTriggerRef.current = triggerElement;
    setSelectedRecipeId(recipeId);
  }

  return (
    <div className="dashboard-grid fade-in">
      <SectionHeader
        title={copy.dashboard.recipes.title}
        copy={copy.dashboard.recipes.description}
      />
      <section className="surface surface--compact surface-pad import-card">
        <SectionHeader
          title={copy.dashboard.recipes.importTitle}
          copy={copy.dashboard.recipes.importCopy}
        />
        <form className="form-grid" onSubmit={onImportRecipe}>
          <Field id="recipe-url" label={copy.dashboard.recipes.urlLabel}>
            <input
              id="recipe-url"
              className="control"
              type="url"
              inputMode="url"
              placeholder={copy.dashboard.recipes.urlPlaceholder}
              value={recipeUrl}
              onChange={(event) => onRecipeUrlChange(event.target.value)}
              required
            />
          </Field>
          <button
            type="submit"
            className="button button--primary button--block"
            disabled={recipeImportState.status === 'queued' || recipeImportState.status === 'running'}
          >
            {recipeImportState.status === 'queued' || recipeImportState.status === 'running'
              ? copy.common.loading
              : copy.dashboard.recipes.button}
          </button>
        </form>
        <OperationStatePanel
          state={recipeImportState}
          loadingTitle={copy.dashboard.recipes.loadingTitle}
          loadingCopy={copy.dashboard.recipes.loadingCopy}
          successTitle={copy.dashboard.recipes.loadingSucceeded}
          errorTitle={copy.dashboard.recipes.loadingFailed}
          meta={
            recipeImportState.status === 'succeeded' || recipeImportState.status === 'failed'
              ? (
                <>
                  {recipeImportState.sourceUrl ? <span className="chip chip--accent">{hostFromUrl(recipeImportState.sourceUrl)}</span> : null}
                  {recipeImportState.job?.id ? <span className="chip">#{recipeImportState.job.id.slice(0, 8)}</span> : null}
                  {recipeImportState.job?.recipe_id ? <span className="chip">recipe #{recipeImportState.job.recipe_id}</span> : null}
                </>
              )
              : null
          }
        />
      </section>
      <section className="surface surface--compact surface-pad recipe-library-section">
        <SectionHeader title={copy.dashboard.recipes.listTitle} />
        {workspace.recipes.length ? (
          <div className="recipe-grid">
            {workspace.recipes.map((recipe) => (
              <RecipeCard
                key={recipe.id}
                copy={copy}
                recipe={recipe}
                locale={locale}
                onOpenDetails={handleOpenDetails}
              />
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <p className="empty-title">{copy.dashboard.recipes.emptyTitle}</p>
            <p className="empty-copy">{copy.dashboard.recipes.emptyText}</p>
          </div>
        )}
      </section>
      {selectedRecipe ? (
        <RecipeDetailDialog
          copy={copy}
          recipe={selectedRecipe}
          locale={locale}
          products={workspace.products}
          groceryLists={workspace.groceryLists}
          onClose={() => setSelectedRecipeId(null)}
          onAddToWeek={onAddRecipeToWeek}
          onAddToGroceryList={onAddRecipeToShoppingList}
          onCreateGroceryList={onCreateShoppingList}
          onAutoMatchRecipe={onAutoMatchRecipe}
          onMatchIngredient={onMatchIngredient}
          onDeleteRecipe={onDeleteRecipe}
          returnFocusRef={detailTriggerRef}
        />
      ) : null}
    </div>
  );
}

function JobsSection({ copy, workspace, locale, onRefreshJobs }) {
  const sortedJobs = sortJobsByCreatedAt(workspace.jobs);
  const pendingJobs = sortedJobs.filter((job) => job.status === 'queued' || job.status === 'running');
  const completedJobs = sortedJobs.filter((job) => job.status === 'succeeded' || job.status === 'failed');

  return (
    <div className="dashboard-grid fade-in">
      <SectionHeader
        title={copy.dashboard.jobs.title}
        copy={copy.dashboard.jobs.description}
        actions={
          <button type="button" className="button button--secondary" onClick={onRefreshJobs}>
            {copy.dashboard.jobs.refreshButton}
          </button>
        }
      />
      <div className="content-grid content-grid--two">
        <section className="surface surface--compact surface-pad list-card">
          <SectionHeader title={copy.dashboard.jobs.pendingTitle} />
          {pendingJobs.length ? (
            <div className="job-stack">
              {pendingJobs.map((job) => (
                <JobCard key={job.id} copy={copy} job={job} locale={locale} />
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <p className="empty-title">{copy.dashboard.jobs.pendingEmptyTitle}</p>
              <p className="empty-copy">{copy.dashboard.jobs.pendingEmptyText}</p>
            </div>
          )}
        </section>
        <section className="surface surface--compact surface-pad list-card">
          <SectionHeader title={copy.dashboard.jobs.historyTitle} />
          {completedJobs.length ? (
            <div className="job-stack">
              {completedJobs.map((job) => (
                <JobCard key={job.id} copy={copy} job={job} locale={locale} />
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <p className="empty-title">{copy.dashboard.jobs.historyEmptyTitle}</p>
              <p className="empty-copy">{copy.dashboard.jobs.historyEmptyText}</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function ProductsSection({
  copy,
  workspace,
  locale,
  productUrl,
  onProductUrlChange,
  productImportState,
  onImportProduct,
}) {
  return (
    <div className="dashboard-grid fade-in">
      <SectionHeader
        title={copy.dashboard.products.title}
        copy={copy.dashboard.products.description}
      />
      <section className="surface surface--compact surface-pad import-card import-card--product">
        <SectionHeader
          title={copy.dashboard.products.importTitle}
          copy={copy.dashboard.products.importCopy}
        />
        <form className="form-grid" onSubmit={onImportProduct}>
          <Field id="product-url" label={copy.dashboard.products.urlLabel}>
            <input
              id="product-url"
              className="control"
              type="url"
              inputMode="url"
              placeholder={copy.dashboard.products.urlPlaceholder}
              value={productUrl}
              onChange={(event) => onProductUrlChange(event.target.value)}
              required
            />
          </Field>
          <button
            type="submit"
            className="button button--primary button--block button--product-import"
            disabled={productImportState.status === 'running'}
          >
            {productImportState.status === 'running' ? copy.common.loading : copy.dashboard.products.button}
          </button>
        </form>
        <OperationStatePanel
          state={productImportState}
          loadingTitle={copy.dashboard.products.importTitle}
          loadingCopy={copy.dashboard.products.importCopy}
          successTitle={copy.dashboard.products.importTitle}
          errorTitle={copy.dashboard.products.importTitle}
          meta={
            productImportState.status === 'succeeded' || productImportState.status === 'failed'
              ? <span className="chip chip--accent">{hostFromUrl(productImportState.sourceUrl)}</span>
              : null
          }
        />
      </section>
      {workspace.products.length ? (
        <>
          <h2 className="section-divider-label">{copy.dashboard.products.title}</h2>
          <div className="product-grid">
            {workspace.products.map((product) => (
              <ProductCard key={product.id} copy={copy} product={product} locale={locale} />
            ))}
          </div>
        </>
      ) : (
        <div className="empty-state">
          <p className="empty-title">{copy.dashboard.products.emptyTitle}</p>
          <p className="empty-copy">{copy.dashboard.products.emptyText}</p>
        </div>
      )}
    </div>
  );
}

function WeekSection({
  copy,
  workspace,
  locale,
  weekDraft,
  onWeekDraftChange,
  onAddWeekPlan,
  onRemoveWeekPlan,
}) {
  const matchedRecipes = workspace.recipes.filter((recipe) => recipe.is_fully_matched);
  const groupedEntries = dayOrder.map((day) => ({
    day,
    entries: workspace.weekPlan.filter((entry) => entry.day === day),
  }));

  return (
    <div className="dashboard-grid fade-in">
      <SectionHeader
        title={copy.dashboard.week.title}
        copy={copy.dashboard.week.description}
      />
      <div className="week-layout">
        <section className="surface surface--compact surface-pad planner-card">
          <SectionHeader
            title={copy.dashboard.week.button}
            copy={copy.dashboard.week.description}
          />
          <form className="form-grid" onSubmit={onAddWeekPlan}>
            <Field id="week-recipe" label={copy.dashboard.week.recipeLabel}>
              <select
                id="week-recipe"
                className="select"
                value={weekDraft.recipeId}
                onChange={(event) => onWeekDraftChange('recipeId', event.target.value)}
                disabled={!matchedRecipes.length}
                required
              >
                {matchedRecipes.length ? (
                  matchedRecipes.map((recipe) => (
                    <option key={recipe.id} value={String(recipe.id)}>
                      {recipe.name}
                    </option>
                  ))
                ) : (
                  <option value="">{copy.dashboard.recipes.emptyTitle}</option>
                )}
              </select>
            </Field>
            <Field id="week-day" label={copy.dashboard.week.dayLabel}>
              <select
                id="week-day"
                className="select"
                value={weekDraft.day}
                onChange={(event) => onWeekDraftChange('day', event.target.value)}
              >
                {dayOrder.map((day) => (
                  <option key={day} value={day}>
                    {copy.dashboard.week.days[day]}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="week-persons" label={copy.dashboard.week.personsLabel}>
              <input
                id="week-persons"
                className="control"
                type="number"
                min="1"
                step="1"
                value={weekDraft.persons}
                onChange={(event) => onWeekDraftChange('persons', event.target.value)}
                required
              />
            </Field>
            <button type="submit" className="button button--primary button--block" disabled={!workspace.recipes.length}>
              {copy.dashboard.week.button}
            </button>
          </form>
          {!matchedRecipes.length ? (
            <div className="empty-state">
              <p className="empty-title">{copy.dashboard.recipes.matchRequiredTitle}</p>
              <p className="empty-copy">{copy.dashboard.recipes.matchRequired}</p>
            </div>
          ) : null}
        </section>
        <section className="surface surface--compact surface-pad">
          <SectionHeader title={copy.dashboard.week.title} />
          <div className="week-days">
            {groupedEntries.map(({ day, entries }) => (
              <article key={day} className="surface surface--compact day-card">
                <div className="day-card-head">
                  <div className="day-card-copy">
                    <div className="day-name">{copy.dashboard.week.days[day]}</div>
                    <p className="day-summary">{weekSummaryText(copy, entries.length)}</p>
                  </div>
                  <span className="chip">{entries.length}</span>
                </div>
                <div className="day-entries">
                  {entries.length ? (
                    entries.map((entry) => (
                      <div key={entry.id} className="plan-row plan-row--compact">
                        <div className="plan-meta">
                          <h3 className="plan-title">{entry.recipe_name}</h3>
                          <span className="chip chip--accent">{weekPersonsText(copy, entry.persons)}</span>
                        </div>
                        <div className="inline-actions">
                          <button
                            type="button"
                            className="button button--secondary button--pill"
                            onClick={() => onRemoveWeekPlan(entry.id)}
                          >
                            {copy.dashboard.week.removeLabel}
                          </button>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="day-empty">
                      <div>
                        <strong className="empty-title">{copy.dashboard.week.emptyTitle}</strong>
                        <p className="empty-copy">{copy.dashboard.week.emptyText}</p>
                      </div>
                    </div>
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function ShoppingSection({
  copy,
  workspace,
  locale,
  shoppingState,
  onCreateList,
  onSelectList,
  onBuildList,
  onUpdateListItem,
}) {
  const items = workspace.activeGroceryList?.items || [];
  const lists = workspace.groceryLists || [];
  const [listName, setListName] = useState('');
  const [includeWeekPlan, setIncludeWeekPlan] = useState(true);
  const [selectedRecipeIds, setSelectedRecipeIds] = useState([]);
  const [quantityDrafts, setQuantityDrafts] = useState({});
  const matchedRecipes = workspace.recipes.filter((recipe) => recipe.is_fully_matched);

  useEffect(() => {
    const nextDrafts = {};
    for (const item of items) {
      nextDrafts[item.id] = String(item.quantity ?? '');
    }
    setQuantityDrafts(nextDrafts);
  }, [items]);

  function toggleRecipe(recipeId) {
    setSelectedRecipeIds((current) => (
      current.includes(recipeId)
        ? current.filter((id) => id !== recipeId)
        : [...current, recipeId]
    ));
  }

  async function handleCreateList(event) {
    event.preventDefault();
    const nextName = listName.trim();
    if (!nextName) {
      return;
    }
    await onCreateList(nextName);
    setListName('');
  }

  async function handleBuildList() {
    if (!workspace.activeGroceryList) {
      return;
    }

    await onBuildList(workspace.activeGroceryList.id, {
      include_weekplan: includeWeekPlan,
      recipe_ids: selectedRecipeIds,
    });
  }

  async function persistQuantity(item) {
    if (!workspace.activeGroceryList) {
      return;
    }

    const draftValue = quantityDrafts[item.id] ?? '';
    const nextQuantity = Number(draftValue);
    if (!Number.isFinite(nextQuantity) || nextQuantity <= 0) {
      setQuantityDrafts((current) => ({
        ...current,
        [item.id]: String(item.quantity),
      }));
      return;
    }

    if (nextQuantity === Number(item.quantity)) {
      return;
    }

    try {
      await onUpdateListItem(workspace.activeGroceryList.id, item.id, {
        quantity: nextQuantity,
      });
    } catch {
      setQuantityDrafts((current) => ({
        ...current,
        [item.id]: String(item.quantity),
      }));
    }
  }

  function handleExportJson() {
    if (!workspace.activeGroceryList) {
      return;
    }

    const payload = {
      list: workspace.activeGroceryList.name,
      generated_at: new Date().toISOString(),
      items: workspace.activeGroceryList.items,
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${workspace.activeGroceryList.name.replace(/\s+/g, '-').toLowerCase() || 'grocery-list'}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="dashboard-grid fade-in">
      <SectionHeader
        title={copy.dashboard.shopping.title}
        copy={copy.dashboard.shopping.description}
        actions={(
          <>
            <button type="button" className="button button--primary" onClick={handleBuildList} disabled={!workspace.activeGroceryList}>
              {copy.dashboard.shopping.generateButton}
            </button>
            <button
              type="button"
              className="button button--secondary"
              onClick={handleExportJson}
              disabled={!workspace.activeGroceryList || !workspace.activeGroceryList.items.length}
            >
              {copy.dashboard.shopping.exportJsonButton}
            </button>
          </>
        )}
      />
      <div className="shopping-layout">
        <section className="surface surface--compact surface-pad shopping-card">
          <SectionHeader title={copy.dashboard.shopping.itemsTitle} copy={copy.dashboard.shopping.exportHint} />
          <form className="form-grid" onSubmit={handleCreateList}>
            <Field id="shopping-list-name" label={copy.dashboard.shopping.listNameLabel}>
              <input
                id="shopping-list-name"
                className="control"
                value={listName}
                onChange={(event) => setListName(event.target.value)}
                placeholder={copy.dashboard.shopping.listNamePlaceholder}
              />
            </Field>
            <button type="submit" className="button button--secondary button--block">
              {copy.dashboard.shopping.createListButton}
            </button>
          </form>

          {lists.length ? (
            <Field id="shopping-list-select" label={copy.dashboard.shopping.selectListLabel}>
              <select
                id="shopping-list-select"
                className="select"
                value={String(workspace.activeGroceryList?.id || '')}
                onChange={(event) => onSelectList(Number(event.target.value))}
              >
                {lists.map((list) => (
                  <option key={list.id} value={String(list.id)}>
                    {list.name} ({list.item_count})
                  </option>
                ))}
              </select>
            </Field>
          ) : null}

          <div className="shopping-composer surface surface--compact surface-pad">
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={includeWeekPlan}
                onChange={(event) => setIncludeWeekPlan(event.target.checked)}
              />
              <span>{copy.dashboard.shopping.includeWeekPlanLabel}</span>
            </label>
            <div className="shopping-recipe-picks">
              {matchedRecipes.map((recipe) => (
                <label key={recipe.id} className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={selectedRecipeIds.includes(recipe.id)}
                    onChange={() => toggleRecipe(recipe.id)}
                  />
                  <span>{recipe.name}</span>
                </label>
              ))}
            </div>
          </div>

          {items.length ? (
            <div className="shopping-list">
              {items.map((item) => (
                <article key={item.id} className="shopping-row">
                  <div className="shopping-details">
                    <div className="shopping-meta">
                      <h3 className="shopping-title">{item.product_title}</h3>
                      <span className="shopping-match shopping-match--good">{item.unit}</span>
                    </div>
                    <p className="shopping-copy">{item.recipe_names.join(', ')}</p>
                    <div className="inline-actions">
                      <input
                        className="control shopping-qty-control"
                        type="number"
                        min="0"
                        step="0.1"
                        value={quantityDrafts[item.id] ?? ''}
                        onChange={(event) => {
                          const nextValue = event.target.value;
                          setQuantityDrafts((current) => ({
                            ...current,
                            [item.id]: nextValue,
                          }));
                        }}
                        onBlur={() => {
                          persistQuantity(item);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            event.currentTarget.blur();
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="button button--secondary"
                        onClick={() => {
                          onUpdateListItem(workspace.activeGroceryList.id, item.id, { remove: true }).catch(() => {
                            // Notice is handled centrally in onUpdateShoppingListItem.
                          });
                        }}
                      >
                        {copy.dashboard.week.removeLabel}
                      </button>
                    </div>
                  </div>
                  <div className="link-row">
                    <a className="link-button" href={item.product_url} target="_blank" rel="noreferrer">
                      {copy.dashboard.products.openSource}
                    </a>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <p className="empty-title">{copy.dashboard.shopping.emptyTitle}</p>
              <p className="empty-copy">{copy.dashboard.shopping.emptyText}</p>
            </div>
          )}
        </section>
        <section className="surface surface--compact surface-pad export-card">
          <SectionHeader title={copy.dashboard.shopping.exportTitle} copy={copy.dashboard.shopping.exportCopy} />
          <OperationStatePanel
            state={shoppingState}
            loadingTitle={copy.dashboard.shopping.generateButton}
            loadingCopy={copy.dashboard.shopping.exportHint}
            successTitle={copy.dashboard.shopping.exportReady}
            errorTitle={copy.dashboard.shopping.exportTitle}
            meta={workspace.activeGroceryList ? <span className="chip chip--accent">{workspace.activeGroceryList.name}</span> : null}
          />
          <div className="empty-state">
            <p className="empty-title">{copy.dashboard.shopping.exportSingleHintTitle}</p>
            <p className="empty-copy">{copy.dashboard.shopping.exportSingleHintText}</p>
          </div>
        </section>
      </div>
    </div>
  );
}

function TutorialLightbox({ src, alt, onClose }) {
  const overlayRef = useRef(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    overlayRef.current?.focus();

    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        onClose();
      }
    }

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  return (
    <div ref={overlayRef} tabIndex={-1} className="lightbox-overlay" role="dialog" aria-modal="true" aria-label={alt} onClick={onClose}>
      <img
        className="lightbox-img"
        src={src}
        alt={alt}
        onClick={(event) => event.stopPropagation()}
      />
    </div>
  );
}

function TutorialMedia({ asset }) {
  const [enlarged, setEnlarged] = useState(false);
  const handleClose = useCallback(() => setEnlarged(false), []);

  return (
    <div className="media-card">
      <ImageOrFallback
        src={asset.src}
        alt={asset.alt}
        fallback={<span>{asset.alt}</span>}
        className="media-image"
        fallbackClassName="media-fallback"
        interactive={Boolean(asset.src)}
        onClick={() => setEnlarged(true)}
      />
      <p className="media-caption">{asset.caption}</p>
      {enlarged ? <TutorialLightbox src={asset.src} alt={asset.alt} onClose={handleClose} /> : null}
    </div>
  );
}

function TutorialScreen({
  copy,
  lang,
  theme,
  onLangChange,
  onThemeToggle,
  onBrandClick,
  onBackToApp,
  sessionUser,
  chapterId,
  onSelectChapter,
}) {
  const chapters = copy.tutorial.chapters;
  const activeChapter = chapters.find((chapter) => chapter.id === chapterId) || chapters[0];
  const activeIndex = Math.max(chapters.findIndex((chapter) => chapter.id === activeChapter.id), 0);
  const actions = [
    {
      label: copy.nav.backToApp,
      onClick: onBackToApp,
      variant: 'primary',
    },
  ];

  return (
    <div className="screen-shell screen-shell--app stack fade-in">
      <ShellTopBar
        copy={copy}
        lang={lang}
        theme={theme}
        userLabel={sessionUser ? sessionUser.username : ''}
        onBrandClick={onBrandClick}
        onLangChange={onLangChange}
        onThemeToggle={onThemeToggle}
        actions={actions}
        mode="app"
      />
      <section className="surface surface-pad">
        <SectionHeader title={copy.tutorial.title} copy={copy.tutorial.subtitle} note={copy.tutorial.assetHint} />
      </section>
      <div className="tutorial-layout">
        <nav className="surface surface-pad chapter-nav" aria-label={copy.tutorial.title}>
          {chapters.map((chapter, index) => (
            <button
              key={chapter.id}
              type="button"
              className={`chapter-button ${chapter.id === activeChapter.id ? 'is-active' : ''}`}
              onClick={() => onSelectChapter(chapter.id)}
            >
              <span className="chapter-number">{index + 1}</span>
              <span className="chapter-button-copy">
                <strong>{chapter.title}</strong>
                <span>{snippet(chapter.summary, 86)}</span>
              </span>
            </button>
          ))}
        </nav>
        <article className="surface chapter-panel">
          <div className="chapter-banner">
            <div className="chapter-copy-stack">
              <span className="chip chip--accent">
                {activeIndex + 1}/{chapters.length}
              </span>
              <h2 className="chapter-title">{activeChapter.title}</h2>
              <p className="chapter-summary">{activeChapter.summary}</p>
              <span className="section-note">
                {activeChapter.steps.length} {copy.tutorial.stepsLabel}
              </span>
              {activeChapter.api ? <span className="chapter-api">{activeChapter.api}</span> : null}
            </div>
            {activeChapter.asset ? <TutorialMedia key={activeChapter.id} asset={activeChapter.asset} /> : null}
          </div>
          <div className="chapter-steps">
            {activeChapter.steps.map((step, index) => (
              <div key={step} className="step-row">
                <span className="step-index">{index + 1}</span>
                <div className="step-copy">{step}</div>
              </div>
            ))}
          </div>
        </article>
      </div>
    </div>
  );
}

function DashboardScreen({
  copy,
  lang,
  theme,
  onLangChange,
  onThemeToggle,
  onBrandClick,
  onOpenTutorial,
  onGoHome,
  onLogout,
  sessionUser,
  workspace,
  activeSection,
  onSelectSection,
  recipeUrl,
  onRecipeUrlChange,
  recipeImportState,
  onImportRecipe,
  onAddRecipeToWeek,
  onAddRecipeToShoppingList,
  onCreateShoppingList,
  onAutoMatchRecipe,
  onMatchIngredient,
  onDeleteRecipe,
  productUrl,
  onProductUrlChange,
  productImportState,
  onImportProduct,
  weekDraft,
  onWeekDraftChange,
  onAddWeekPlan,
  onRemoveWeekPlan,
  shoppingState,
  onSelectShoppingList,
  onBuildShoppingList,
  onUpdateShoppingListItem,
  onRefreshJobs,
  notice,
}) {
  const summaryCards = [
    { label: copy.dashboard.stats.recipes, value: workspace.recipes.length },
    { label: copy.dashboard.stats.products, value: workspace.products.length },
    { label: copy.dashboard.stats.week, value: workspace.weekPlan.length },
    { label: copy.dashboard.stats.shopping, value: workspace.activeGroceryList?.items.length || 0 },
  ];

  const actions = [
    {
      label: copy.nav.tutorial,
      onClick: onOpenTutorial,
      variant: 'secondary',
    },
    {
      label: copy.nav.home,
      onClick: onGoHome,
      variant: 'secondary',
    },
    {
      label: copy.nav.logout,
      onClick: onLogout,
      variant: 'primary',
    },
  ];
  const mobileNavigation = {
    label: copy.dashboard.title,
    items: dashboardTabs.map((tab) => ({
      key: tab,
      label: copy.dashboard.tabs[tab],
      active: activeSection === tab,
      onClick: () => handleSelectSection(tab),
    })),
  };

  function handleSelectSection(tab) {
    onSelectSection(tab);

    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  let content = null;
  if (activeSection === 'recipes') {
    content = (
      <RecipesSection
        copy={copy}
        workspace={workspace}
        locale={lang === 'nl' ? 'nl-NL' : 'en-GB'}
        recipeUrl={recipeUrl}
        onRecipeUrlChange={onRecipeUrlChange}
        recipeImportState={recipeImportState}
        onImportRecipe={onImportRecipe}
        onAddRecipeToWeek={onAddRecipeToWeek}
        onAddRecipeToShoppingList={onAddRecipeToShoppingList}
        onCreateShoppingList={onCreateShoppingList}
        onAutoMatchRecipe={onAutoMatchRecipe}
        onMatchIngredient={onMatchIngredient}
        onDeleteRecipe={onDeleteRecipe}
      />
    );
  } else if (activeSection === 'products') {
    content = (
      <ProductsSection
        copy={copy}
        workspace={workspace}
        locale={lang === 'nl' ? 'nl-NL' : 'en-GB'}
        productUrl={productUrl}
        onProductUrlChange={onProductUrlChange}
        productImportState={productImportState}
        onImportProduct={onImportProduct}
      />
    );
  } else if (activeSection === 'week') {
    content = (
      <WeekSection
        copy={copy}
        workspace={workspace}
        locale={lang === 'nl' ? 'nl-NL' : 'en-GB'}
        weekDraft={weekDraft}
        onWeekDraftChange={onWeekDraftChange}
        onAddWeekPlan={onAddWeekPlan}
        onRemoveWeekPlan={onRemoveWeekPlan}
      />
    );
  } else if (activeSection === 'shopping') {
    content = (
      <ShoppingSection
        copy={copy}
        workspace={workspace}
        locale={lang === 'nl' ? 'nl-NL' : 'en-GB'}
        shoppingState={shoppingState}
        onCreateList={onCreateShoppingList}
        onSelectList={onSelectShoppingList}
        onBuildList={onBuildShoppingList}
        onUpdateListItem={onUpdateShoppingListItem}
      />
    );
  } else if (activeSection === 'jobs') {
    content = (
      <JobsSection
        copy={copy}
        workspace={workspace}
        locale={lang === 'nl' ? 'nl-NL' : 'en-GB'}
        onRefreshJobs={onRefreshJobs}
      />
    );
  } else if (activeSection === 'dashboard') {
    content = (
      <div className="dashboard-grid fade-in">
        <SectionHeader
          title={copy.dashboard.title}
          copy={copy.dashboard.subtitle}
        />
        <div className="summary-grid">
          {summaryCards.map((card) => (
            <article key={card.label} className="surface surface--compact summary-card">
              <span className="summary-label">{card.label}</span>
              <span className="summary-value">{card.value}</span>
              {card.detail ? <span className="summary-detail">{card.detail}</span> : null}
            </article>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="screen-shell screen-shell--app stack fade-in">
      <ShellTopBar
        copy={copy}
        lang={lang}
        theme={theme}
        userLabel={sessionUser.username}
        onBrandClick={onBrandClick}
        onLangChange={onLangChange}
        onThemeToggle={onThemeToggle}
        actions={actions}
        mobileNavigation={mobileNavigation}
        mode="app"
      />
      <NoticeBanner notice={notice} />
      <div className="section-tabs" role="tablist" aria-label={copy.dashboard.title}>
        {dashboardTabs.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeSection === tab}
            className={`button section-tab ${activeSection === tab ? 'is-active' : ''}`}
            onClick={() => handleSelectSection(tab)}
          >
            {copy.dashboard.tabs[tab]}
          </button>
        ))}
      </div>
      <section className="dashboard-content-shell">{content}</section>
    </div>
  );
}

function App() {
  const [lang, setLang] = useState(getInitialLanguage);
  const [theme, setTheme] = useState(getInitialTheme);
  const copy = dictionaries[lang];
  const [view, setView] = useState('landing');
  const [session, setSession] = useState({
    token: getStoredValue(storageKeys.token),
    user: null,
    booting: true,
  });
  const [workspace, setWorkspace] = useState(createEmptyWorkspace());
  const [activeSection, setActiveSection] = useState('dashboard');
  const [authMode, setAuthMode] = useState('login');
  const [authForm, setAuthForm] = useState(createEmptyAuthForm());
  const [authMessage, setAuthMessage] = useState({ type: '', text: '' });
  const [authBusy, setAuthBusy] = useState(false);
  const [recipeUrl, setRecipeUrl] = useState('');
  const [productUrl, setProductUrl] = useState('');
  const [recipeImportState, setRecipeImportState] = useState({
    status: 'idle',
    text: '',
    job: null,
    sourceUrl: '',
  });
  const [productImportState, setProductImportState] = useState({
    status: 'idle',
    text: '',
    sourceUrl: '',
  });
  const [shoppingState, setShoppingState] = useState({
    status: 'idle',
    text: '',
  });
  const [dashboardNotice, setDashboardNotice] = useState({ type: '', text: '' });
  const [weekDraft, setWeekDraft] = useState(createEmptyWeekDraft());
  const [tutorialChapterId, setTutorialChapterId] = useState(copy.tutorial.chapters[0].id);
  const authPanelRef = useRef(null);
  const mountedRef = useRef(true);
  const recipeImportRunRef = useRef(0);
  const activeGroceryListIdRef = useRef(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    activeGroceryListIdRef.current = workspace.activeGroceryList?.id ?? null;
  }, [workspace.activeGroceryList]);

  useEffect(() => {
    setStoredValue(storageKeys.language, lang);
    document.documentElement.lang = lang;
  }, [lang]);

  useEffect(() => {
    setStoredValue(storageKeys.theme, theme);
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  useEffect(() => {
    if (view === 'tutorial') {
      document.title = `${copy.brand.name} · ${copy.tutorial.title}`;
      return;
    }

    if (view === 'dashboard' && session.user) {
      document.title = `${copy.brand.name} · ${copy.dashboard.title}`;
      return;
    }

    document.title = `${copy.brand.name} · ${copy.landing.title}`;
  }, [copy, session.user, view]);

  useEffect(() => {
    if (!copy.tutorial.chapters.some((chapter) => chapter.id === tutorialChapterId)) {
      setTutorialChapterId(copy.tutorial.chapters[0].id);
    }
  }, [copy, tutorialChapterId]);

  async function loadWorkspace(token, preferredGroceryListId = null) {
    const [recipes, products, weekPlan, jobs, groceryLists] = await Promise.all([
      listRecipes(token),
      listProducts(token),
      listWeekPlan(token),
      listImportJobs(token),
      listGroceryLists(token),
    ]);

    let activeGroceryList = null;
    if (groceryLists.length) {
      const targetListId = preferredGroceryListId || activeGroceryListIdRef.current;
      const selected = groceryLists.find((list) => list.id === targetListId) || groceryLists[0];
      activeGroceryList = await getGroceryList(token, selected.id);
    }

    if (!mountedRef.current) {
      return false;
    }

    const firstMatchedRecipe = recipes.find((recipe) => recipe.is_fully_matched);
    setWorkspace({ recipes, products, weekPlan, jobs, groceryLists, activeGroceryList });
    setWeekDraft((current) => ({
      ...current,
      recipeId: recipes.some((recipe) => String(recipe.id) === String(current.recipeId || ''))
        ? current.recipeId
        : (firstMatchedRecipe ? String(firstMatchedRecipe.id) : ''),
    }));
    setDashboardNotice({ type: '', text: '' });
    return true;
  }

  async function refreshWorkspace(token, preferredGroceryListId = null) {
    try {
      await loadWorkspace(token, preferredGroceryListId);
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        clearSession(error.message);
        return false;
      }

      setDashboardNotice({
        type: 'danger',
        text: error.message || copy.common.loading,
      });
      return false;
    }
  }

  function clearSession(message = '') {
    removeStoredValue(storageKeys.token);
    recipeImportRunRef.current += 1;
    setSession({
      token: '',
      user: null,
      booting: false,
    });
    setWorkspace(createEmptyWorkspace());
    setView('landing');
    setActiveSection('dashboard');
    setAuthMode('login');
    setAuthBusy(false);
    setAuthForm(createEmptyAuthForm());
    setAuthMessage(message ? { type: 'danger', text: message } : { type: '', text: '' });
    setRecipeUrl('');
    setProductUrl('');
    setRecipeImportState({ status: 'idle', text: '', job: null, sourceUrl: '' });
    setProductImportState({ status: 'idle', text: '', sourceUrl: '' });
    setShoppingState({ status: 'idle', text: '' });
    setDashboardNotice({ type: '', text: '' });
    setWeekDraft(createEmptyWeekDraft());
  }

  function goHome() {
    setView('landing');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function openTutorial() {
    setView('tutorial');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function backToApp() {
    setView(session.user ? 'dashboard' : 'landing');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function openDashboard() {
    if (session.user) {
      setView('dashboard');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    setAuthMode('login');
    authPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function onLanguageChange(nextLanguage) {
    setLang(nextLanguage);
  }

  function onThemeToggle() {
    setTheme((currentTheme) => (currentTheme === 'dark' ? 'light' : 'dark'));
  }

  function onAuthFieldChange(field, value) {
    setAuthForm((current) => ({
      ...current,
      [field]: value,
    }));
  }

  function onChangeAuthMode(nextMode) {
    setAuthMode(nextMode);
    setAuthMessage({ type: '', text: '' });
  }

  async function completeAuth(payload) {
    setStoredValue(storageKeys.token, payload.access_token);
    setSession({
      token: payload.access_token,
      user: payload.user,
      booting: false,
    });
    setWorkspace(createEmptyWorkspace());
    setView('dashboard');
    setActiveSection('dashboard');
    setAuthMessage({ type: '', text: '' });
    setDashboardNotice({ type: '', text: '' });
    setRecipeUrl('');
    setProductUrl('');
    setRecipeImportState({ status: 'idle', text: '', job: null, sourceUrl: '' });
    setProductImportState({ status: 'idle', text: '', sourceUrl: '' });
    setShoppingState({ status: 'idle', text: '' });
    setWeekDraft(createEmptyWeekDraft());
    setAuthForm(createEmptyAuthForm());
    await refreshWorkspace(payload.access_token);
  }

  async function onLoginSubmit(event) {
    event.preventDefault();
    setAuthBusy(true);
    setAuthMessage({ type: '', text: '' });

    try {
      const payload = await loginAccount({
        identifier: authForm.identifier.trim(),
        password: authForm.password,
      });
      await completeAuth(payload);
    } catch (error) {
      setAuthMessage({
        type: 'danger',
        text: error.message || copy.auth.messages.error,
      });
    } finally {
      if (mountedRef.current) {
        setAuthBusy(false);
      }
    }
  }

  async function onRegisterSubmit(event) {
    event.preventDefault();
    setAuthBusy(true);
    setAuthMessage({ type: '', text: '' });

    try {
      const payload = await registerAccount({
        email: authForm.email.trim().toLowerCase(),
        username: authForm.username.trim() || undefined,
        password: authForm.password,
      });
      await completeAuth(payload);
    } catch (error) {
      setAuthMessage({
        type: 'danger',
        text: error.message || copy.auth.messages.error,
      });
    } finally {
      if (mountedRef.current) {
        setAuthBusy(false);
      }
    }
  }

  async function onImportRecipe(event) {
    event.preventDefault();
    const url = recipeUrl.trim();
    if (!url) {
      return;
    }

    recipeImportRunRef.current += 1;
    const runId = recipeImportRunRef.current;
    setRecipeImportState({
      status: 'queued',
      text: copy.dashboard.recipes.loadingQueued,
      job: null,
      sourceUrl: url,
    });

    try {
      const job = await createRecipeImportJob(session.token, url);
      if (recipeImportRunRef.current !== runId || !mountedRef.current) {
        return;
      }

      setRecipeImportState({
        status: job.status,
        text: recipeStatusText(copy, job.status),
        job,
        sourceUrl: url,
      });

      const finalJob = job.status === 'queued' || job.status === 'running'
        ? await waitForRecipeImportJob(session.token, job.id, {
          onUpdate: (nextJob) => {
            if (recipeImportRunRef.current !== runId || !mountedRef.current) {
              return;
            }

            setRecipeImportState({
              status: nextJob.status,
              text: recipeStatusText(copy, nextJob.status),
              job: nextJob,
              sourceUrl: url,
            });
          },
        })
        : job;

      if (recipeImportRunRef.current !== runId || !mountedRef.current) {
        return;
      }

      if (finalJob.status === 'failed') {
        throw new Error(finalJob.error || copy.dashboard.recipes.loadingFailed);
      }

      setRecipeImportState({
        status: 'succeeded',
        text: copy.dashboard.recipes.loadingSucceeded,
        job: finalJob,
        sourceUrl: url,
      });
      setRecipeUrl('');
      await refreshWorkspace(session.token);
    } catch (error) {
      if (recipeImportRunRef.current !== runId || !mountedRef.current) {
        return;
      }

      setRecipeImportState({
        status: 'failed',
        text: error.message || copy.dashboard.recipes.loadingFailed,
        job: null,
        sourceUrl: url,
      });
      setDashboardNotice({
        type: 'danger',
        text: error.message || copy.dashboard.recipes.loadingFailed,
      });
    }
  }

  async function onImportProduct(event) {
    event.preventDefault();
    const url = productUrl.trim();
    if (!url) {
      return;
    }

    setProductImportState({
      status: 'running',
      text: copy.common.loading,
      sourceUrl: url,
    });

    try {
      const product = await importProduct(session.token, url);
      if (!mountedRef.current) {
        return;
      }

      setProductImportState({
        status: 'succeeded',
        text: product.title,
        sourceUrl: url,
      });
      setProductUrl('');
      await refreshWorkspace(session.token);
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }

      setProductImportState({
        status: 'failed',
        text: error.message || copy.dashboard.products.button,
        sourceUrl: url,
      });
      setDashboardNotice({
        type: 'danger',
        text: error.message || copy.dashboard.products.button,
      });
    }
  }

  async function onAddWeekPlan(event) {
    event.preventDefault();
    if (!weekDraft.recipeId) {
      return;
    }

    try {
      await saveWeekPlanEntry(weekDraft.recipeId, weekDraft.day, weekDraft.persons);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        return;
      }

      setDashboardNotice({
        type: 'danger',
        text: error.message || copy.dashboard.week.addError,
      });
    }
  }

  async function onRemoveWeekPlan(entryId) {
    try {
      await deleteWeekPlan(session.token, entryId);
      await refreshWorkspace(session.token);
    } catch (error) {
      setDashboardNotice({
        type: 'danger',
        text: error.message || copy.dashboard.week.removeLabel,
      });
    }
  }

  async function onAutoMatchRecipe(recipeId) {
    await autoMatchRecipe(session.token, recipeId);
    await refreshWorkspace(session.token);
  }

  async function onMatchIngredient(recipeId, ingredientId, payload) {
    await matchRecipeIngredient(session.token, recipeId, ingredientId, payload);
    await refreshWorkspace(session.token);
  }

  async function onCreateShoppingList(name) {
    setShoppingState({ status: 'running', text: copy.common.loading });
    try {
      const created = await createGroceryList(session.token, name);
      const [groceryLists, activeGroceryList] = await Promise.all([
        listGroceryLists(session.token),
        getGroceryList(session.token, created.id),
      ]);
      activeGroceryListIdRef.current = created.id;
      setWorkspace((current) => ({ ...current, groceryLists, activeGroceryList }));
      setShoppingState({ status: 'succeeded', text: copy.dashboard.shopping.createListButton });
      return created;
    } catch (error) {
      setShoppingState({ status: 'failed', text: error.message || copy.dashboard.shopping.createListButton });
      setDashboardNotice({ type: 'danger', text: error.message || copy.dashboard.shopping.createListButton });
      throw error;
    }
  }

  async function onAddRecipeToShoppingList(listId, payload) {
    setShoppingState({ status: 'running', text: copy.common.loading });
    try {
      const activeGroceryList = await addRecipeToGroceryList(session.token, listId, payload);
      const groceryLists = await listGroceryLists(session.token);
      activeGroceryListIdRef.current = listId;
      setWorkspace((current) => ({ ...current, groceryLists, activeGroceryList }));
      setShoppingState({ status: 'succeeded', text: copy.dashboard.recipes.addedToList });
      return activeGroceryList;
    } catch (error) {
      setShoppingState({ status: 'failed', text: error.message || copy.dashboard.recipes.addToListFailed });
      setDashboardNotice({ type: 'danger', text: error.message || copy.dashboard.recipes.addToListFailed });
      throw error;
    }
  }

  async function onSelectShoppingList(listId) {
    try {
      const activeGroceryList = await getGroceryList(session.token, listId);
      activeGroceryListIdRef.current = listId;
      setWorkspace((current) => ({ ...current, activeGroceryList }));
    } catch (error) {
      setDashboardNotice({ type: 'danger', text: error.message || copy.dashboard.shopping.selectListLabel });
    }
  }

  async function onBuildShoppingList(listId, payload) {
    setShoppingState({ status: 'running', text: copy.common.loading });
    try {
      const activeGroceryList = await buildGroceryList(session.token, listId, payload);
      const groceryLists = await listGroceryLists(session.token);
      setWorkspace((current) => ({ ...current, groceryLists, activeGroceryList }));
      setShoppingState({ status: 'succeeded', text: copy.dashboard.shopping.exportReady });
    } catch (error) {
      setShoppingState({ status: 'failed', text: error.message || copy.dashboard.shopping.generateButton });
      setDashboardNotice({ type: 'danger', text: error.message || copy.dashboard.shopping.generateButton });
    }
  }

  async function onUpdateShoppingListItem(listId, itemId, payload) {
    try {
      const activeGroceryList = await updateGroceryListItem(session.token, listId, itemId, payload);
      const groceryLists = await listGroceryLists(session.token);
      activeGroceryListIdRef.current = listId;
      setWorkspace((current) => ({ ...current, groceryLists, activeGroceryList }));
    } catch (error) {
      setDashboardNotice({ type: 'danger', text: error.message || copy.dashboard.shopping.refreshButton });
      throw error;
    }
  }

  async function onDeleteRecipe(recipeId) {
    try {
      await deleteRecipe(session.token, recipeId);
      await refreshWorkspace(session.token);
      setDashboardNotice({ type: 'success', text: copy.dashboard.recipes.deleteSucceeded });
    } catch (error) {
      setDashboardNotice({ type: 'danger', text: error.message || copy.dashboard.recipes.deleteFailed });
      throw error;
    }
  }

  async function saveWeekPlanEntry(recipeId, day, persons) {
    const nextPersons = Math.max(1, Number(persons) || 1);
    try {
      await addWeekPlan(session.token, {
        day,
        recipe_id: Number(recipeId),
        persons: nextPersons,
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        clearSession(error.message);
      }

      throw error;
    }

    setWeekDraft({
      day,
      recipeId: String(recipeId),
      persons: nextPersons,
    });
    await refreshWorkspace(session.token);
  }

  async function onAddRecipeToWeek(recipeId, detailDraft) {
    await saveWeekPlanEntry(recipeId, detailDraft.day, detailDraft.persons);
  }

  function onWeekDraftChange(field, value) {
    setWeekDraft((current) => ({
      ...current,
      [field]: field === 'persons' ? Number(value) : value,
    }));
  }

  useEffect(() => {
    let cancelled = false;
    const token = getStoredValue(storageKeys.token);

    async function bootstrap() {
      if (!token) {
        if (!cancelled) {
          setSession({
            token: '',
            user: null,
            booting: false,
          });
        }
        return;
      }

      try {
        const user = await loadCurrentUser(token);
        if (cancelled || !mountedRef.current) {
          return;
        }

        setSession({
          token,
          user,
          booting: false,
        });
        setView('dashboard');
        const loaded = await refreshWorkspace(token);
        if (!loaded && mountedRef.current) {
          setDashboardNotice({
            type: 'warning',
            text: copy.common.loading,
          });
        }
      } catch (error) {
        if (cancelled || !mountedRef.current) {
          return;
        }

        if (error instanceof ApiError && error.status === 401) {
          clearSession(error.message);
          return;
        }

        setSession({
          token: '',
          user: null,
          booting: false,
        });
        setView('landing');
        setAuthMessage({
          type: 'danger',
          text: error.message || copy.auth.messages.error,
        });
      }
    }

    bootstrap();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (session.booting) {
    return <BootScreen copy={copy} />;
  }

  if (view === 'tutorial') {
    return (
      <TutorialScreen
        copy={copy}
        lang={lang}
        theme={theme}
        onLangChange={onLanguageChange}
        onThemeToggle={onThemeToggle}
        onBrandClick={backToApp}
        onBackToApp={backToApp}
        sessionUser={session.user}
        chapterId={tutorialChapterId}
        onSelectChapter={setTutorialChapterId}
      />
    );
  }

  if (view === 'dashboard' && session.user) {
    return (
      <DashboardScreen
        copy={copy}
        lang={lang}
        theme={theme}
        onLangChange={onLanguageChange}
        onThemeToggle={onThemeToggle}
        onBrandClick={goHome}
        onOpenTutorial={openTutorial}
        onGoHome={goHome}
        onLogout={clearSession}
        sessionUser={session.user}
        workspace={workspace}
        activeSection={activeSection}
        onSelectSection={setActiveSection}
        recipeUrl={recipeUrl}
        onRecipeUrlChange={setRecipeUrl}
        recipeImportState={recipeImportState}
        onImportRecipe={onImportRecipe}
        onAddRecipeToWeek={onAddRecipeToWeek}
        onAddRecipeToShoppingList={onAddRecipeToShoppingList}
        onCreateShoppingList={onCreateShoppingList}
        onAutoMatchRecipe={onAutoMatchRecipe}
        onMatchIngredient={onMatchIngredient}
        onDeleteRecipe={onDeleteRecipe}
        productUrl={productUrl}
        onProductUrlChange={setProductUrl}
        productImportState={productImportState}
        onImportProduct={onImportProduct}
        weekDraft={weekDraft}
        onWeekDraftChange={onWeekDraftChange}
        onAddWeekPlan={onAddWeekPlan}
        onRemoveWeekPlan={onRemoveWeekPlan}
        shoppingState={shoppingState}
        onSelectShoppingList={onSelectShoppingList}
        onBuildShoppingList={onBuildShoppingList}
        onUpdateShoppingListItem={onUpdateShoppingListItem}
        onRefreshJobs={() => refreshWorkspace(session.token)}
        notice={dashboardNotice}
      />
    );
  }

  return (
    <LandingScreen
      copy={copy}
      lang={lang}
      theme={theme}
      onLangChange={onLanguageChange}
      onThemeToggle={onThemeToggle}
      onOpenTutorial={openTutorial}
      onOpenDashboard={openDashboard}
      onBrandClick={goHome}
      sessionUser={session.user}
      authMode={authMode}
      onChangeAuthMode={onChangeAuthMode}
      authForm={authForm}
      onAuthFieldChange={onAuthFieldChange}
      authMessage={authMessage}
      authBusy={authBusy}
      onLoginSubmit={onLoginSubmit}
      onRegisterSubmit={onRegisterSubmit}
      authPanelRef={authPanelRef}
    />
  );
}

export default App;
