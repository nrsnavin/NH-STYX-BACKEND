# NH Styx — Backend API

B2B wholesale ordering platform API for **garment store owners & boutique owners** to buy all their store needs in one place. Serves the Flutter **customer app** and the React **operations** (admin + agents) web app.

**Stack:** Node.js · Express · TypeScript · Prisma · PostgreSQL · JWT auth · Zod validation · Pino logging.

---

## Quick start

### 1. Prerequisites
- Node.js ≥ 20
- PostgreSQL 16 (or use the provided Docker Compose)

### 2. Install
```bash
npm install
cp .env.example .env   # then edit secrets/DB URL as needed
```

### 3. Database
Spin up Postgres locally with Docker:
```bash
docker compose up -d db
```
Then create the schema and seed demo data:
```bash
npm run prisma:migrate    # creates tables (dev migration)
npm run db:seed           # demo admin / agent / customer + catalog
```

### 4. Run
```bash
npm run dev               # http://localhost:4000/api/v1
```
Health check: `GET http://localhost:4000/api/v1/health`

### Run the full stack in Docker
```bash
docker compose up --build   # api + postgres, migrations auto-applied
```

---

## Seeded accounts

| Role     | Email                | Password      |
|----------|----------------------|---------------|
| Admin    | admin@nhstyx.com     | `Admin@123`    |
| Agent    | agent@nhstyx.com     | `Agent@123`    |
| Customer | customer@nhstyx.com  | `Customer@123` |

---

## Project structure

```
src/
├── app.ts                 # Express app: middleware + route mounting
├── index.ts               # Server bootstrap + graceful shutdown
├── config/
│   ├── env.ts             # Zod-validated environment variables
│   └── logger.ts          # Pino logger
├── lib/
│   └── prisma.ts          # Prisma client singleton
├── middlewares/
│   ├── auth.middleware.ts # authenticate + authorize(roles)
│   ├── error.middleware.ts# centralized error handler + 404
│   └── validate.middleware.ts # Zod request validation
├── modules/               # feature-first modules
│   ├── auth/              # register, login, refresh, logout, me
│   ├── categories/        # category CRUD (admin)
│   ├── products/          # product + variant CRUD, list/search
│   └── orders/            # place order, list (role-aware), status
├── routes/index.ts        # /health + module routers
└── utils/                 # ApiError, asyncHandler, jwt, password, slug
prisma/
├── schema.prisma          # data model
└── seed.ts                # demo data
```

## API surface (v1, prefix `/api/v1`)

| Method | Path                  | Auth        | Description                         |
|--------|-----------------------|-------------|-------------------------------------|
| GET    | `/health`             | public      | Service + DB health                 |
| POST   | `/auth/register`      | public      | Register a store/boutique owner     |
| POST   | `/auth/login`         | public      | Login, returns access+refresh       |
| POST   | `/auth/refresh`       | public      | Rotate refresh token                |
| POST   | `/auth/logout`        | public      | Revoke refresh token                |
| GET    | `/auth/me`            | any         | Current user profile                |
| GET    | `/categories`         | any         | List categories                     |
| POST   | `/categories`         | ADMIN       | Create category                     |
| PATCH  | `/categories/:id`     | ADMIN       | Update category                     |
| DELETE | `/categories/:id`     | ADMIN       | Delete category                     |
| GET    | `/products`           | any         | List/search products (paginated)    |
| GET    | `/products/:id`       | any         | Product detail + variants           |
| POST   | `/products`           | ADMIN       | Create product + variants           |
| PATCH  | `/products/:id`       | ADMIN       | Update product                      |
| DELETE | `/products/:id`       | ADMIN       | Delete product                      |
| POST   | `/orders`             | any         | Place an order                      |
| GET    | `/orders`             | any         | List orders (role-aware)            |
| GET    | `/orders/:id`         | any         | Order detail                        |
| PATCH  | `/orders/:id/status`  | ADMIN/AGENT | Advance order status                |

All protected routes expect `Authorization: Bearer <accessToken>`.

## Scripts

| Script                  | Purpose                              |
|-------------------------|--------------------------------------|
| `npm run dev`           | Dev server (tsx watch)               |
| `npm run build`         | Compile TypeScript → `dist/`         |
| `npm start`             | Run compiled server                  |
| `npm run typecheck`     | Type-check without emitting          |
| `npm run lint`          | ESLint                               |
| `npm run prisma:migrate`| Create/apply dev migration           |
| `npm run prisma:studio` | Open Prisma Studio                   |
| `npm run db:seed`       | Seed demo data                       |
