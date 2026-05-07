# User Tutorial

## 1) Register and log in
1. Open the app.
2. Register with an email address, password, and optional username.
3. After registration, log in with either your username or your email address plus the same password.

## 2) Import recipes from AH Allerhande
1. Open the **Recipes / Recepten** tab.
2. Paste an AH Allerhande recipe URL.
3. Click **Import**.
4. The API stores the recipe name, image, description, normalized ingredients, and cooking steps.

## 3) Import AH products
1. Open the **Products** tab.
2. Paste an AH product URL.
3. Import the product to store its title, image, price, unit, and AH product ID for your account.

## 4) Build your week menu
1. Open **Week menu**.
2. Choose a recipe.
3. Select the day and number of people.
4. Add the entry to your personal week plan.

## 5) Generate the shopping list
1. Open **Grocery list / Shopping cart**.
2. Generate the list from your week plan.
3. The backend merges compatible ingredient quantities and links matching imported products where possible.

## 6) Loading-aware clients
Clients that need visible loading progress can use the async import API:
1. `POST /recipes/import-jobs`
2. Poll `GET /import-jobs/{id}` until the status is `succeeded` or `failed`

## Screenshots
Add screenshots after running the app:
- `docs/screenshots/home.png`
- `docs/screenshots/recipes.png`
