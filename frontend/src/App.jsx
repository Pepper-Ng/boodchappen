import React, { useEffect, useRef, useState } from 'react';
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

function hostFromUrl(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return value;
  }
}

function snippet(value, maxLength = 140) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return '';
  }

  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
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

function ImageOrFallback({ src, alt, fallback, className, fallbackClassName }) {
  const [broken, setBroken] = useState(false);

  if (src && !broken) {
    return <img src={src} alt={alt} className={className} onError={() => setBroken(true)} />;
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

function ShellTopBar({ copy, lang, theme, userLabel, onBrandClick, onLangChange, onThemeToggle, actions }) {
  const themeToggleLabel = theme === 'dark' ? copy.common.light : copy.common.dark;

  return (
    <header className="page-topbar">
      <button type="button" className="button button--ghost brand" onClick={onBrandClick}>
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-copy">
          <span className="brand-name">{copy.brand.name}</span>
          <span className="brand-tagline">{copy.brand.tagline}</span>
        </span>
      </button>
      <div className="toolbar">
        <div className="toolbar-group">
          <span className="toolbar-label">{copy.common.language}</span>
          <button
            type="button"
            className={`button button--pill ${lang === 'nl' ? 'button--active' : 'button--secondary'}`}
            onClick={() => onLangChange('nl')}
            aria-pressed={lang === 'nl'}
          >
            NL
          </button>
          <button
            type="button"
            className={`button button--pill ${lang === 'en' ? 'button--active' : 'button--secondary'}`}
            onClick={() => onLangChange('en')}
            aria-pressed={lang === 'en'}
          >
            EN
          </button>
        </div>
        <div className="toolbar-group">
          <span className="toolbar-label">{copy.common.theme}</span>
          <button type="button" className="button button--secondary button--pill" onClick={onThemeToggle}>
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
              onClick={action.onClick}
              disabled={action.disabled}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
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
    <div className="stack fade-in">
      <ShellTopBar
        copy={copy}
        lang={lang}
        theme={theme}
        userLabel={sessionUser ? sessionUser.username : ''}
        onBrandClick={onBrandClick}
        onLangChange={onLangChange}
        onThemeToggle={onThemeToggle}
        actions={actions}
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

function RecipeCard({ copy, recipe, locale }) {
  const ingredientPreview = recipe.ingredients.slice(0, 3);
  const description = recipe.description ? snippet(recipe.description, 160) : snippet(recipe.instructions, 160);

  return (
    <article className="surface surface--compact recipe-card">
      <ImageOrFallback
        src={recipe.image}
        alt={recipe.name}
        fallback={<span>{recipe.name}</span>}
        className="recipe-cover"
      />
      <div className="recipe-preview">
        <div className="recipe-intro">
          <span className="chip chip--accent">
            {recipe.ingredients.length} {copy.dashboard.recipes.ingredientsLabel}
          </span>
          <h3 className="recipe-title">{recipe.name}</h3>
          {description ? <p className="recipe-copy">{description}</p> : null}
        </div>
        <div className="recipe-meta">
          <span className="chip">{recipe.base_persons} {copy.dashboard.recipes.basePersonsLabel}</span>
          <span className="chip">{hostFromUrl(recipe.source_url)}</span>
          <span className="chip">{localizeDate(recipe.created_at, locale, { dateStyle: 'medium' })}</span>
        </div>
        <p className="recipe-snippet">{snippet(recipe.instructions, 180)}</p>
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
          <a className="link-button" href={recipe.source_url} target="_blank" rel="noreferrer">
            {copy.dashboard.recipes.openSource}
          </a>
        </div>
      </div>
    </article>
  );
}

function ProductCard({ copy, product, locale }) {
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
          <span className="chip">{hostFromUrl(product.source_url)}</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">{copy.dashboard.products.sourceLabel}</span>
          <span className="detail-value">{hostFromUrl(product.source_url)}</span>
        </div>
        <div className="link-row">
          <a className="link-button" href={product.source_url} target="_blank" rel="noreferrer">
            {copy.dashboard.products.openSource}
          </a>
        </div>
      </div>
    </article>
  );
}

function JobCard({ copy, job, locale }) {
  const statusLabel = copy.dashboard.recipes.statusLabels[job.status] || job.status;

  return (
    <article className="surface surface--compact job-card">
      <div className="job-meta">
        <span className={`job-status ${jobStatusClass(job.status)}`}>{statusLabel}</span>
        <span className="chip">{localizeDate(job.created_at, locale, { dateStyle: 'medium', timeStyle: 'short' })}</span>
      </div>
      <h3 className="job-title">{hostFromUrl(job.source_url)}</h3>
      <p className="job-copy">{job.source_url}</p>
      <div className="job-details">
        {job.recipe_id ? (
          <div className="detail-row">
            <span className="detail-label">Recipe</span>
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
}) {
  const recentJobs = workspace.jobs.slice(0, 5);

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
                <JobCard key={job.id} copy={copy} job={job} locale={locale} />
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
              <RecipeCard key={recipe.id} copy={copy} recipe={recipe} locale={locale} />
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <p className="empty-title">{copy.dashboard.recipes.emptyTitle}</p>
            <p className="empty-copy">{copy.dashboard.recipes.emptyText}</p>
          </div>
        )}
      </section>
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
      <div className="content-grid content-grid--two">
        <section className="surface surface--compact surface-pad import-card">
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
              className="button button--primary button--block"
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
              {workspace.products.slice(0, 5).map((product) => (
                <div key={product.id} className="surface surface--compact job-card">
                  <div className="job-meta">
                    <span className="chip chip--accent">{product.ah_id}</span>
                    <span className="chip">{formatPrice(product.price, locale)}</span>
                  </div>
                  <h3 className="job-title">{product.title}</h3>
                  <p className="job-copy">{snippet(product.description || '', 150) || hostFromUrl(product.source_url)}</p>
                  <div className="detail-row">
                    <span className="detail-label">{copy.dashboard.products.sourceLabel}</span>
                    <span className="detail-value">{hostFromUrl(product.source_url)}</span>
                  </div>
                  <div className="link-row">
                    <a className="link-button" href={product.source_url} target="_blank" rel="noreferrer">
                      {copy.dashboard.products.openSource}
                    </a>
                  </div>
                </div>
              ))}
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
                <div className="day-name">{copy.dashboard.week.days[day]}</div>
                <div className="day-entries">
                  {entries.length ? (
                    entries.map((entry) => (
                      <div key={entry.id} className="plan-row plan-row--compact">
                        <div className="plan-meta">
                          <h3 className="plan-title">{entry.recipe_name}</h3>
                          <span className="chip chip--accent">
                            {entry.persons} {copy.dashboard.week.personsLabel.toLowerCase()}
                          </span>
                        </div>
                        <p className="plan-subtitle">{copy.dashboard.week.dayLabel}: {copy.dashboard.week.days[day]}</p>
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

function TutorialMedia({ asset }) {
  return (
    <div className="media-card">
      <ImageOrFallback
        src={asset.src}
        alt={asset.alt}
        fallback={<span>{asset.alt}</span>}
        className="media-image"
        fallbackClassName="media-fallback"
      />
      <p className="media-caption">{asset.caption}</p>
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
    <div className="stack fade-in">
      <ShellTopBar
        copy={copy}
        lang={lang}
        theme={theme}
        userLabel={sessionUser ? sessionUser.username : ''}
        onBrandClick={onBrandClick}
        onLangChange={onLangChange}
        onThemeToggle={onThemeToggle}
        actions={actions}
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
              <span>{chapter.title}</span>
            </button>
          ))}
        </nav>
        <article className="surface chapter-panel">
          <span className="chip chip--accent">
            {activeIndex + 1}/{chapters.length}
          </span>
          <h2 className="chapter-title">{activeChapter.title}</h2>
          <p className="chapter-summary">{activeChapter.summary}</p>
          <span className="chapter-api">{activeChapter.api}</span>
          <div className="chapter-steps">
            {activeChapter.steps.map((step, index) => (
              <div key={step} className="step-row">
                <span className="step-index">{index + 1}</span>
                <div className="step-copy">{step}</div>
              </div>
            ))}
          </div>
          {activeChapter.asset ? <TutorialMedia key={activeChapter.id} asset={activeChapter.asset} /> : null}
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
    <div className="stack fade-in">
      <ShellTopBar
        copy={copy}
        lang={lang}
        theme={theme}
        userLabel={sessionUser.username}
        onBrandClick={onBrandClick}
        onLangChange={onLangChange}
        onThemeToggle={onThemeToggle}
        actions={actions}
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
      await addWeekPlan(session.token, {
        day: weekDraft.day,
        recipe_id: Number(weekDraft.recipeId),
        persons: Number(weekDraft.persons) || 1,
      });
      await refreshWorkspace(session.token);
    } catch (error) {
      setDashboardNotice({
        type: 'danger',
        text: error.message || copy.dashboard.week.button,
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
