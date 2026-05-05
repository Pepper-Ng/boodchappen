# Boodschappen Clone

A self-hostable recipe-to-grocery planner inspired by boodschapie.nl.

## Features
- Multi-user accounts.
- Import AH Allerhande recipe by URL (name, image, description, ingredients, instructions).
- Plan recipes across week days with person scaling.
- Aggregate ingredients into a grocery list.
- Basic tabs: Recipes, Products, Week menu, Grocery list, Shopping cart.
- Dutch and English UI labels.
- Dark/light mode.

## Run locally
```bash
docker compose up --build
```
Open frontend on `http://localhost:5173` and backend docs on `http://localhost:8000/docs`.

## Architecture
- `backend`: FastAPI + SQLModel + SQLite
- `frontend`: React + Vite

## Portainer deploy
Use "Git repository" stack, point to this repo, and deploy `docker-compose.yml`.
