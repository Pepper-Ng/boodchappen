import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import en from './i18n/en.json';
import nl from './i18n/nl.json';
import {
  ApiError,
  addWeekPlan,
  createRecipeImportJob,
  deleteWeekPlan,
  importProduct,
  listImportJobs,
  listProducts,
  listRecipes,
  listWeekPlan,
  loadCurrentUser,
  loadShoppingList,
  loadShoppingListExport,
  loginAccount,
  registerAccount,
  waitForRecipeImportJob,
} from './services/api.js';

const dictionaries = { en, nl };
const storageKeys = {
  token: 'boodschappen.token',
  language: 'boodschappen.language',
  theme: 'boodschappen.theme',
};
const dashboardTabs = ['recipes', 'products', 'week', 'shopping'];
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
    shoppingList: { items: [], export_lines: [] },
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

function shortExportLine(item, locale) {
  const quantity = Number(item?.quantity || 0);
  const parts = [];

  if (quantity > 0) {
    parts.push(formatQuantity(quantity, locale));
  }

  if (item?.unit) {
    parts.push(item.unit);
  }

  parts.push(item?.name || item?.normalized_name || '');
  return parts.filter(Boolean).join(' ');
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
              <button type="button" className="button button--secondary nav-drawer-item" onClick={handleThemeClick}>
                {themeToggleLabel}
              </button>
            </div>
            {userLabel ? <span className="chip chip--accent nav-drawer-chip">{userLabel}</span> : null}
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

function RecipeDetailDialog({ copy, recipe, locale, onClose, onAddToWeek, returnFocusRef }) {
  const dialogRef = useRef(null);
  const titleRef = useRef(null);
  const [planDraft, setPlanDraft] = useState(() => createRecipeDetailDraft(recipe));
  const [planningBusy, setPlanningBusy] = useState(false);
  const [planningNotice, setPlanningNotice] = useState({ type: '', text: '' });
  const [showFullDescription, setShowFullDescription] = useState(false);
  const [showAllIngredients, setShowAllIngredients] = useState(false);
  const [showAllInstructions, setShowAllInstructions] = useState(false);
  const titleId = `recipe-detail-title-${recipe.id}`;
  const leadId = `recipe-detail-lead-${recipe.id}`;
  const descriptionRegionId = `recipe-detail-description-${recipe.id}`;
  const ingredientsRegionId = `recipe-detail-ingredients-${recipe.id}`;
  const instructionsRegionId = `recipe-detail-instructions-${recipe.id}`;
  const descriptionParagraphs = textParagraphs(recipe.description);
  const instructionSteps = textParagraphs(recipe.instructions);
  const visibleDescription = showFullDescription ? descriptionParagraphs : descriptionParagraphs.slice(0, 2);
  const visibleIngredients = showAllIngredients ? recipe.ingredients : recipe.ingredients.slice(0, 6);
  const visibleInstructions = showAllInstructions ? instructionSteps : instructionSteps.slice(0, 4);
  const sourceUrl = normalizeExternalUrl(recipe.source_url);
  const sourceHost = hostFromUrl(sourceUrl);
  const recipeLead = descriptionParagraphs[0] || sourceHost || snippet(recipe.instructions, 180);

  useEffect(() => {
    setPlanDraft(createRecipeDetailDraft(recipe));
    setPlanningBusy(false);
    setPlanningNotice({ type: '', text: '' });
    setShowFullDescription(false);
    setShowAllIngredients(false);
    setShowAllInstructions(false);
  }, [recipe.id, recipe.base_persons]);

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

  const dialog = (
    <div className="recipe-detail-overlay" onClick={onClose}>
      <section
        ref={dialogRef}
        className="surface recipe-detail-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={leadId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="recipe-detail-shell">
          <div className="recipe-detail-handle" aria-hidden="true" />
          <div className="recipe-detail-header">
            <div className="recipe-detail-heading">
              <span className="eyebrow">{copy.dashboard.recipes.viewRecipe}</span>
              <h2 id={titleId} ref={titleRef} tabIndex={-1} className="recipe-detail-title">{recipe.name}</h2>
              <p id={leadId} className="recipe-detail-lead">
                {recipeLead}
              </p>
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
            <aside className="recipe-detail-rail">
              <ImageOrFallback
                src={recipe.image}
                alt={recipe.name}
                fallback={<span>{recipe.name}</span>}
                className="recipe-detail-cover"
                fallbackClassName="recipe-thumb recipe-detail-cover"
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
                  <button type="submit" className="button button--primary button--block" disabled={planningBusy}>
                    {planningBusy ? copy.common.loading : copy.dashboard.week.button}
                  </button>
                </form>
              </section>
            </aside>

            <div className="recipe-detail-main">
              <div className="recipe-detail-summary-grid">
                <section className="detail-card">
                  <div className="panel-heading">
                    <h3 className="panel-title">{copy.dashboard.recipes.descriptionTitle}</h3>
                    {descriptionParagraphs.length > 2 ? (
                      <button
                        type="button"
                        className="link-button detail-toggle"
                        aria-expanded={showFullDescription}
                        aria-controls={descriptionRegionId}
                        onClick={() => setShowFullDescription((current) => !current)}
                      >
                        {showFullDescription ? copy.common.showLess : copy.common.showMore}
                      </button>
                    ) : null}
                  </div>
                  <div id={descriptionRegionId} className="detail-copy-stack">
                    {visibleDescription.length ? (
                      visibleDescription.map((paragraph, index) => (
                        <p key={`${recipe.id}-description-${index + 1}`} className="detail-paragraph">
                          {paragraph}
                        </p>
                      ))
                    ) : (
                      <p className="detail-paragraph detail-paragraph--muted">{copy.dashboard.recipes.descriptionEmpty}</p>
                    )}
                  </div>
                </section>

                <section className="detail-card">
                  <div className="panel-heading">
                    <h3 className="panel-title">{copy.dashboard.recipes.ingredientsTitle}</h3>
                    {recipe.ingredients.length > 6 ? (
                      <button
                        type="button"
                        className="link-button detail-toggle"
                        aria-expanded={showAllIngredients}
                        aria-controls={ingredientsRegionId}
                        onClick={() => setShowAllIngredients((current) => !current)}
                      >
                        {showAllIngredients
                          ? copy.dashboard.recipes.showFewerIngredients
                          : copy.dashboard.recipes.showAllIngredients}
                      </button>
                    ) : null}
                  </div>
                  <div id={ingredientsRegionId} className="recipe-detail-ingredients">
                    {visibleIngredients.map((ingredient, index) => (
                      <div key={`${recipe.id}-ingredient-${index + 1}`} className="recipe-detail-ingredient">
                        <strong>{ingredient.raw_text}</strong>
                        <span>
                          {formatQuantity(ingredient.quantity, locale)} {ingredient.unit}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              </div>

              <section className="detail-card detail-card--instructions">
                <div className="panel-heading">
                  <h3 className="panel-title">{copy.dashboard.recipes.instructionsTitle}</h3>
                  {instructionSteps.length > 4 ? (
                    <button
                      type="button"
                      className="link-button detail-toggle"
                      aria-expanded={showAllInstructions}
                      aria-controls={instructionsRegionId}
                      onClick={() => setShowAllInstructions((current) => !current)}
                    >
                      {showAllInstructions
                        ? copy.dashboard.recipes.showFewerInstructions
                        : copy.dashboard.recipes.showAllInstructions}
                    </button>
                  ) : null}
                </div>
                <ol id={instructionsRegionId} className="recipe-instruction-list">
                  {visibleInstructions.map((step, index) => (
                    <li key={`${recipe.id}-step-${index + 1}`} className="instruction-step">
                      <span className="instruction-index">{index + 1}</span>
                      <span className="instruction-copy">{step}</span>
                    </li>
                  ))}
                </ol>
              </section>
            </div>
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
  const statusLabel = copy.dashboard.recipes.statusLabels[job.status] || job.status;
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

function ShoppingRow({ copy, item, locale }) {
  const hasProduct = Boolean(item.product_title);
  const matchLabel = hasProduct ? copy.dashboard.shopping.matchedLabel : copy.dashboard.shopping.searchLabel;
  const matchClass = hasProduct ? 'shopping-match shopping-match--good' : 'shopping-match shopping-match--search';

  return (
    <article className="shopping-row">
      <div className="shopping-details">
        <div className="shopping-meta">
          <h3 className="shopping-title">{shortExportLine(item, locale)}</h3>
          <span className={matchClass}>{matchLabel}</span>
        </div>
        {hasProduct ? (
          <p className="shopping-copy">
            {copy.dashboard.shopping.productLabel}: {item.product_title}
          </p>
        ) : item.search_url ? (
          <p className="shopping-copy">{hostFromUrl(item.search_url)}</p>
        ) : null}
      </div>
      <div className="link-row">
        {item.product_url ? (
          <a className="link-button" href={item.product_url} target="_blank" rel="noreferrer">
            {copy.dashboard.products.openSource}
          </a>
        ) : null}
        {item.search_url ? (
          <a className="link-button" href={item.search_url} target="_blank" rel="noreferrer">
            {copy.dashboard.shopping.searchLabel}
          </a>
        ) : null}
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
}) {
  const [selectedRecipeId, setSelectedRecipeId] = useState(null);
  const detailTriggerRef = useRef(null);
  const recentJobs = workspace.jobs.slice(0, 4);
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
      <div className="content-grid content-grid--two">
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
        <section className="surface surface--compact surface-pad list-card">
          <SectionHeader title={copy.dashboard.recipes.jobsTitle} />
          {recentJobs.length ? (
            <div className="job-stack">
              {recentJobs.map((job) => (
                <JobCard key={job.id} copy={copy} job={job} locale={locale} compact />
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <p className="empty-title">{copy.dashboard.recipes.jobsEmpty}</p>
              <p className="empty-copy">{copy.dashboard.recipes.loadingCopy}</p>
            </div>
          )}
        </section>
      </div>
      <section className="surface surface--compact surface-pad">
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
          onClose={() => setSelectedRecipeId(null)}
          onAddToWeek={onAddRecipeToWeek}
          returnFocusRef={detailTriggerRef}
        />
      ) : null}
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
      <div className="content-grid content-grid--two content-grid--products">
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
        <section className="surface surface--compact surface-pad list-card">
          <SectionHeader title={copy.dashboard.products.importTitle} />
          {workspace.products.length ? (
            <div className="job-stack">
              {workspace.products.slice(0, 5).map((product) => {
                const sourceUrl = normalizeExternalUrl(product.source_url);
                const sourceHost = hostFromUrl(sourceUrl);
                const productSummary = snippet(product.description || '', 150) || sourceHost;

                return (
                  <div key={product.id} className="surface surface--compact job-card">
                    <div className="job-meta">
                      <span className="chip chip--accent">{product.ah_id}</span>
                      <span className="chip">{formatPrice(product.price, locale)}</span>
                    </div>
                    <h3 className="job-title">{product.title}</h3>
                    {productSummary ? <p className="job-copy">{productSummary}</p> : null}
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
                );
              })}
            </div>
          ) : (
            <div className="empty-state">
              <p className="empty-title">{copy.dashboard.products.emptyTitle}</p>
              <p className="empty-copy">{copy.dashboard.products.emptyText}</p>
            </div>
          )}
        </section>
      </div>
      {workspace.products.length ? (
        <section className="surface surface--compact surface-pad">
          <SectionHeader title={copy.dashboard.products.title} />
          <div className="product-grid">
            {workspace.products.map((product) => (
              <ProductCard key={product.id} copy={copy} product={product} locale={locale} />
            ))}
          </div>
        </section>
      ) : null}
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
                disabled={!workspace.recipes.length}
                required
              >
                {workspace.recipes.length ? (
                  workspace.recipes.map((recipe) => (
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
          {!workspace.recipes.length ? (
            <div className="empty-state">
              <p className="empty-title">{copy.dashboard.week.emptyTitle}</p>
              <p className="empty-copy">{copy.dashboard.week.emptyText}</p>
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
  onGenerateShopping,
  onCopyShopping,
  onRefreshShopping,
}) {
  const exportLines = workspace.shoppingList.export_lines || [];
  const items = workspace.shoppingList.items || [];

  return (
    <div className="dashboard-grid fade-in">
      <SectionHeader
        title={copy.dashboard.shopping.title}
        copy={copy.dashboard.shopping.description}
        actions={(
          <>
            <button type="button" className="button button--primary" onClick={onGenerateShopping}>
              {copy.dashboard.shopping.generateButton}
            </button>
            <button
              type="button"
              className="button button--secondary"
              onClick={onCopyShopping}
              disabled={!exportLines.length}
            >
              {copy.dashboard.shopping.copyButton}
            </button>
            <button type="button" className="button button--secondary" onClick={onRefreshShopping}>
              {copy.dashboard.shopping.refreshButton}
            </button>
          </>
        )}
      />
      <div className="shopping-layout">
        <section className="surface surface--compact surface-pad shopping-card">
          <SectionHeader title={copy.dashboard.shopping.itemsTitle} copy={copy.dashboard.shopping.exportHint} />
          {items.length ? (
            <div className="shopping-list">
              {items.map((item) => (
                <ShoppingRow key={`${item.normalized_name}-${item.name}`} copy={copy} item={item} locale={locale} />
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
            meta={exportLines.length ? <span className="chip chip--accent">{exportLines.length} lines</span> : null}
          />
          {exportLines.length ? (
            <div className="export-lines">
              {exportLines.map((line) => (
                <div key={line} className="export-line">
                  {line}
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <p className="empty-title">{copy.dashboard.shopping.emptyTitle}</p>
              <p className="empty-copy">{copy.dashboard.shopping.emptyText}</p>
            </div>
          )}
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
  productUrl,
  onProductUrlChange,
  productImportState,
  onImportProduct,
  weekDraft,
  onWeekDraftChange,
  onAddWeekPlan,
  onRemoveWeekPlan,
  shoppingState,
  onGenerateShopping,
  onCopyShopping,
  onRefreshShopping,
  notice,
}) {
  const summaryCards = [
    { label: copy.dashboard.stats.recipes, value: workspace.recipes.length },
    { label: copy.dashboard.stats.products, value: workspace.products.length },
    { label: copy.dashboard.stats.week, value: workspace.weekPlan.length },
    { label: copy.dashboard.stats.shopping, value: workspace.shoppingList.items.length },
    { label: copy.dashboard.stats.jobs, value: workspace.jobs.length },
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
      onClick: () => onSelectSection(tab),
    })),
  };

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
        onGenerateShopping={onGenerateShopping}
        onCopyShopping={onCopyShopping}
        onRefreshShopping={onRefreshShopping}
      />
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
      <section className="surface surface-pad dashboard-grid">
        <SectionHeader
          title={copy.dashboard.title}
          copy={copy.dashboard.subtitle}
          note={replaceTemplate(copy.dashboard.welcome, { username: sessionUser.username })}
        />
        <NoticeBanner notice={notice} />
        <div className="summary-grid">
          {summaryCards.map((card) => (
            <article key={card.label} className="surface surface--compact summary-card">
              <span className="summary-label">{card.label}</span>
              <span className="summary-value">{card.value}</span>
            </article>
          ))}
        </div>
      </section>
      <div className="section-tabs" role="tablist" aria-label={copy.dashboard.title}>
        {dashboardTabs.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeSection === tab}
            className={`button section-tab ${activeSection === tab ? 'is-active' : ''}`}
            onClick={() => onSelectSection(tab)}
          >
            {copy.dashboard.tabs[tab]}
          </button>
        ))}
      </div>
      <section className="surface surface-pad">{content}</section>
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
  const [activeSection, setActiveSection] = useState('recipes');
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

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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

  async function loadWorkspace(token) {
    const [recipes, products, weekPlan, shoppingList, jobs] = await Promise.all([
      listRecipes(token),
      listProducts(token),
      listWeekPlan(token),
      loadShoppingList(token),
      listImportJobs(token),
    ]);

    if (!mountedRef.current) {
      return false;
    }

    setWorkspace({ recipes, products, weekPlan, shoppingList, jobs });
    setWeekDraft((current) => ({
      ...current,
      recipeId: current.recipeId || (recipes[0] ? String(recipes[0].id) : ''),
    }));
    setDashboardNotice({ type: '', text: '' });
    return true;
  }

  async function refreshWorkspace(token) {
    try {
      await loadWorkspace(token);
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
    setActiveSection('recipes');
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
    setActiveSection('recipes');
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

  async function onGenerateShopping() {
    setShoppingState({
      status: 'running',
      text: copy.common.loading,
    });

    try {
      const shoppingList = await loadShoppingListExport(session.token);
      if (!mountedRef.current) {
        return;
      }

      setWorkspace((current) => ({
        ...current,
        shoppingList,
      }));
      setShoppingState({
        status: 'succeeded',
        text: copy.dashboard.shopping.exportReady,
      });
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }

      setShoppingState({
        status: 'failed',
        text: error.message || copy.dashboard.shopping.generateButton,
      });
      setDashboardNotice({
        type: 'danger',
        text: error.message || copy.dashboard.shopping.generateButton,
      });
    }
  }

  async function onCopyShopping() {
    const exportText = (workspace.shoppingList.export_lines || []).join('\n');
    if (!exportText) {
      return;
    }

    try {
      if (window.navigator.clipboard?.writeText) {
        await window.navigator.clipboard.writeText(exportText);
      } else {
        window.prompt(copy.dashboard.shopping.exportTitle, exportText);
      }
    } catch (error) {
      setDashboardNotice({
        type: 'danger',
        text: error.message || copy.dashboard.shopping.copyButton,
      });
    }
  }

  async function onRefreshShopping() {
    await refreshWorkspace(session.token);
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
        productUrl={productUrl}
        onProductUrlChange={setProductUrl}
        productImportState={productImportState}
        onImportProduct={onImportProduct}
        weekDraft={weekDraft}
        onWeekDraftChange={onWeekDraftChange}
        onAddWeekPlan={onAddWeekPlan}
        onRemoveWeekPlan={onRemoveWeekPlan}
        shoppingState={shoppingState}
        onGenerateShopping={onGenerateShopping}
        onCopyShopping={onCopyShopping}
        onRefreshShopping={onRefreshShopping}
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
