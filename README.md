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

**Staff** (operations console — email + password):

| Role  | Email             | Password    |
|-------|-------------------|-------------|
| Admin | admin@nhstyx.com  | `Admin@123` |
| Agent | agent@nhstyx.com  | `Agent@123` |

**Customer** (mobile app — phone + password):

| Shop                    | Phone        | Password       |
|-------------------------|--------------|----------------|
| Trendy Threads Boutique | `9876543210` | `Customer@123` |

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
│   ├── auth/              # staff + customer login, refresh, me
│   ├── categories/        # category tree CRUD (admin)
│   ├── products/          # flat products + GST + price tiers
│   ├── cart/              # server-side customer cart
│   ├── addresses/         # customer delivery addresses
│   ├── orders/            # GST checkout, payments, status
│   └── customers/         # staff customer management
├── routes/index.ts        # /health + module routers
└── utils/                 # ApiError, asyncHandler, jwt, password, slug, pricing (GST)
prisma/
├── schema.prisma          # data model (integer paise, GST-ready)
└── seed.ts                # demo data
```

> **Money is integer paise** everywhere (₹250 → `25000`). Prices are
> **GST-exclusive**; tax is computed at checkout from each product's
> `gstRatePercent` and split **CGST+SGST** (intra-state) or **IGST**
> (inter-state) based on the customer's state vs `SELLER_STATE_CODE`.

## API surface (v1, prefix `/api/v1`)

| Method | Path                              | Auth        | Description                          |
|--------|-----------------------------------|-------------|--------------------------------------|
| GET    | `/health`                         | public      | Service + DB health                  |
| POST   | `/auth/staff/login`               | public      | Staff login (email)                  |
| GET    | `/auth/staff/me`                  | STAFF       | Current staff profile                |
| POST   | `/auth/customer/register`         | public      | Register a shop (phone)              |
| POST   | `/auth/customer/login`            | public      | Customer login (phone)               |
| GET    | `/auth/customer/me`               | CUSTOMER    | Current customer profile             |
| POST   | `/auth/refresh`                   | public      | Re-issue token pair (stateless)      |
| GET    | `/categories`                     | any         | List category tree                   |
| POST/PATCH/DELETE | `/categories...`       | ADMIN       | Manage categories                    |
| GET    | `/products` · `/products/:id`     | any         | List/search · detail (+tiers)        |
| POST/PATCH/DELETE | `/products...`         | ADMIN       | Manage products + price tiers        |
| GET    | `/cart`                           | CUSTOMER    | Cart with tier-resolved pricing      |
| POST   | `/cart/items`                     | CUSTOMER    | Add to cart                          |
| PATCH/DELETE | `/cart/items/:productId`    | CUSTOMER    | Update qty / remove                  |
| GET/POST/PATCH/DELETE | `/addresses...`    | CUSTOMER    | Manage delivery addresses            |
| POST   | `/orders`                         | CUSTOMER    | Checkout cart → GST order            |
| GET    | `/orders` · `/orders/:id`         | any         | List (role-aware) · detail           |
| POST   | `/orders/:id/pay/razorpay/verify` | CUSTOMER    | Verify Razorpay payment              |
| PATCH  | `/orders/:id/status`              | ADMIN/AGENT | Advance order status                 |
| POST   | `/orders/:id/payments`            | ADMIN/AGENT | Record offline payment (COD/bank)    |
| GET    | `/customers` · `/customers/:id`   | STAFF       | List / view customers                |
| PATCH  | `/customers/:id`                  | ADMIN       | Update credit terms / status         |

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
