import 'dotenv/config';
import { PrismaClient, ProductUnit, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const hash = (plain: string) => bcrypt.hash(plain, 10);

async function main() {
  console.log('🌱 Seeding NH Styx database...');

  // --- Stores (single state for now: Maharashtra / 27) ---
  const pune = await prisma.store.upsert({
    where: { code: 'PUN' },
    update: {},
    create: {
      name: 'NH Styx — Pune',
      code: 'PUN',
      phone: '9000010001',
      addressLine: 'Unit 4, Market Yard',
      city: 'Pune',
      state: 'Maharashtra',
      stateCode: '27',
      pincode: '411001',
    },
  });
  const mumbai = await prisma.store.upsert({
    where: { code: 'MUM' },
    update: {},
    create: {
      name: 'NH Styx — Mumbai',
      code: 'MUM',
      phone: '9000020001',
      addressLine: 'Shop 12, Dadar West',
      city: 'Mumbai',
      state: 'Maharashtra',
      stateCode: '27',
      pincode: '400028',
    },
  });

  // Service areas → which store serves which city (normalized lower-case key).
  const area = (label: string, storeId: string) =>
    prisma.serviceArea.upsert({
      where: { city: label.trim().toLowerCase() },
      update: { storeId, label },
      create: { city: label.trim().toLowerCase(), label, storeId },
    });
  await area('Pune', pune.id);
  await area('Pimpri-Chinchwad', pune.id);
  await area('Hadapsar', pune.id);
  await area('Mumbai', mumbai.id);
  await area('Navi Mumbai', mumbai.id);
  await area('Thane', mumbai.id);
  console.log('   Stores Pune & Mumbai ready with service areas.');

  // --- Staff (User) — agent belongs to the Pune store ---
  await prisma.user.upsert({
    where: { email: 'admin@nhstyx.com' },
    update: {},
    create: {
      name: 'NH Styx Admin',
      email: 'admin@nhstyx.com',
      phone: '9000000001',
      password: await hash('Admin@123'),
      role: Role.ADMIN,
    },
  });
  await prisma.user.upsert({
    where: { email: 'agent@nhstyx.com' },
    update: { storeId: pune.id },
    create: {
      name: 'Field Agent One',
      email: 'agent@nhstyx.com',
      phone: '9000000002',
      password: await hash('Agent@123'),
      role: Role.AGENT,
      storeId: pune.id,
    },
  });

  // --- Customer (shop owner) in Pune → served by the Pune store ---
  const customer = await prisma.customer.upsert({
    where: { phone: '9876543210' },
    update: { storeId: pune.id },
    create: {
      shopName: 'Trendy Threads Boutique',
      ownerName: 'Asha Verma',
      phone: '9876543210',
      email: 'asha@trendythreads.in',
      gstin: '27ABCDE1234F1Z5',
      password: await hash('Customer@123'),
      creditLimitPaise: 5_00_000, // ₹5,000
      creditDays: 30,
      storeId: pune.id,
      cart: { create: {} },
      addresses: {
        create: {
          label: 'Shop',
          line1: '14, MG Road',
          line2: 'Near Clock Tower',
          city: 'Pune',
          state: 'Maharashtra',
          stateCode: '27',
          pincode: '411001',
          isDefault: true,
        },
      },
    },
  });
  console.log(`   Customer ${customer.shopName} ready (store: Pune).`);

  // --- Categories (Amazon-style tree: top-level + sub-categories) ---
  const cat = (name: string, slug: string, sortOrder: number, parentId?: string) =>
    prisma.category.upsert({
      where: { slug },
      update: {},
      create: { name, slug, sortOrder, parentId },
    });

  const apparel = await cat('Apparel', 'apparel', 1);
  const kurtis = await cat('Kurtis & Tops', 'kurtis-tops', 1, apparel.id);
  const sarees = await cat('Sarees', 'sarees', 2, apparel.id);
  const menswear = await cat('Menswear', 'menswear', 3, apparel.id);

  const packaging = await cat('Packaging', 'packaging', 2);
  const covers = await cat('Covers & Bags', 'covers-bags', 1, packaging.id);

  const hangers = await cat('Hangers & Display', 'hangers-display', 3);
  const tags = await cat('Tags & Labels', 'tags-labels', 4);
  const fixtures = await cat('Store Fixtures', 'store-fixtures', 5);
  const trims = await cat('Trims & Accessories', 'trims-accessories', 6);

  // --- Catalog products (shared) + per-store stock & price ---
  interface Tier {
    minQty: number;
    pricePaise: number;
  }
  interface Seed {
    name: string;
    slug: string;
    description: string;
    brand: string;
    categoryId: string;
    unit: ProductUnit;
    hsnCode: string;
    gstRatePercent: number;
    mrpPaise?: number;
    moqQty: number;
    // Pune store inventory
    pricePaise: number;
    stockQty: number;
    tiers?: Tier[];
    // Also stock in Mumbai? Mumbai prices ~8% higher to show per-store pricing.
    inMumbai?: boolean;
  }

  const catalog = (s: Seed) =>
    prisma.product.upsert({
      where: { slug: s.slug },
      update: {},
      create: {
        name: s.name,
        slug: s.slug,
        description: s.description,
        brand: s.brand,
        categoryId: s.categoryId,
        unit: s.unit,
        hsnCode: s.hsnCode,
        gstRatePercent: s.gstRatePercent,
        mrpPaise: s.mrpPaise,
        moqQty: s.moqQty,
      },
    });

  async function stock(
    storeId: string,
    productId: string,
    pricePaise: number,
    stockQty: number,
    tiers?: Tier[],
  ) {
    const sp = await prisma.storeProduct.upsert({
      where: { storeId_productId: { storeId, productId } },
      update: {},
      create: { storeId, productId, pricePaise, stockQty },
    });
    for (const t of tiers ?? []) {
      await prisma.storePriceTier.upsert({
        where: { storeProductId_minQty: { storeProductId: sp.id, minQty: t.minQty } },
        update: {},
        create: { storeProductId: sp.id, minQty: t.minQty, pricePaise: t.pricePaise },
      });
    }
  }

  const bump = (paise: number) => Math.round((paise * 1.08) / 100) * 100; // +8%, whole rupee

  const seeds: Seed[] = [
    {
      name: "Women's Cotton Kurti",
      slug: 'cotton-kurti-seed',
      description: 'Breathable cotton kurti — wholesale pack.',
      brand: 'NH Basics',
      categoryId: kurtis.id,
      unit: ProductUnit.PIECE,
      hsnCode: '6109',
      gstRatePercent: 5,
      mrpPaise: 79900,
      moqQty: 6,
      pricePaise: 32000,
      stockQty: 240,
      tiers: [
        { minQty: 12, pricePaise: 30000 },
        { minQty: 50, pricePaise: 28000 },
      ],
      inMumbai: true,
    },
    {
      name: "Women's Rayon Printed Top",
      slug: 'rayon-top-seed',
      description: 'Trendy rayon tops, mixed prints.',
      brand: 'NH Basics',
      categoryId: kurtis.id,
      unit: ProductUnit.PIECE,
      hsnCode: '6106',
      gstRatePercent: 5,
      mrpPaise: 59900,
      moqQty: 10,
      pricePaise: 24000,
      stockQty: 320,
      tiers: [{ minQty: 50, pricePaise: 21000 }],
      inMumbai: true,
    },
    {
      name: 'Banarasi Silk Saree with Blouse',
      slug: 'silk-saree-seed',
      description: 'Festive Banarasi silk sarees with blouse piece.',
      brand: 'NH Ethnics',
      categoryId: sarees.id,
      unit: ProductUnit.PIECE,
      hsnCode: '5007',
      gstRatePercent: 5,
      mrpPaise: 249900,
      moqQty: 4,
      pricePaise: 120000,
      stockQty: 80,
      tiers: [{ minQty: 12, pricePaise: 110000 }],
      inMumbai: true,
    },
    {
      name: "Men's Formal Shirt (Pack of 5)",
      slug: 'mens-shirt-seed',
      description: 'Wrinkle-free formal shirts, assorted sizes.',
      brand: 'NH Formals',
      categoryId: menswear.id,
      unit: ProductUnit.PACK,
      hsnCode: '6205',
      gstRatePercent: 5,
      mrpPaise: 159900,
      moqQty: 2,
      pricePaise: 95000,
      stockQty: 150,
      inMumbai: true,
    },
    {
      name: 'Wooden Display Hanger (Pack of 50)',
      slug: 'wooden-hanger-seed',
      description: 'Premium wooden hangers for boutiques.',
      brand: 'NH Store',
      categoryId: hangers.id,
      unit: ProductUnit.PACK,
      hsnCode: '4421',
      gstRatePercent: 18,
      mrpPaise: 99900,
      moqQty: 2,
      pricePaise: 45000,
      stockQty: 500,
      tiers: [{ minQty: 10, pricePaise: 42000 }],
      inMumbai: true,
    },
    {
      name: 'Velvet Hangers (Pack of 100)',
      slug: 'velvet-hanger-seed',
      description: 'Non-slip velvet hangers, space-saving.',
      brand: 'NH Store',
      categoryId: hangers.id,
      unit: ProductUnit.PACK,
      hsnCode: '3926',
      gstRatePercent: 18,
      moqQty: 1,
      pricePaise: 78000,
      stockQty: 220,
      inMumbai: true,
    },
    {
      name: 'Poly Packaging Covers (Box of 500)',
      slug: 'poly-packaging-seed',
      description: 'Transparent garment packaging covers.',
      brand: 'NH Store',
      categoryId: covers.id,
      unit: ProductUnit.BOX,
      hsnCode: '3923',
      gstRatePercent: 18,
      moqQty: 1,
      pricePaise: 60000,
      stockQty: 300,
    },
    {
      name: 'Kraft Paper Carry Bags (Pack of 100)',
      slug: 'kraft-bags-seed',
      description: 'Eco-friendly branded carry bags.',
      brand: 'NH Store',
      categoryId: covers.id,
      unit: ProductUnit.PACK,
      hsnCode: '4819',
      gstRatePercent: 18,
      moqQty: 5,
      pricePaise: 35000,
      stockQty: 400,
      tiers: [{ minQty: 20, pricePaise: 32000 }],
    },
    {
      name: 'Printed Garment Tags (Pack of 1000)',
      slug: 'garment-tags-seed',
      description: 'Custom-printable hang tags with string.',
      brand: 'NH Store',
      categoryId: tags.id,
      unit: ProductUnit.PACK,
      hsnCode: '4821',
      gstRatePercent: 18,
      moqQty: 2,
      pricePaise: 28000,
      stockQty: 600,
    },
    {
      name: 'Female Retail Mannequin',
      slug: 'mannequin-seed',
      description: 'Full-body fibre mannequin for window display.',
      brand: 'NH Fixtures',
      categoryId: fixtures.id,
      unit: ProductUnit.PIECE,
      hsnCode: '9618',
      gstRatePercent: 18,
      mrpPaise: 499900,
      moqQty: 1,
      pricePaise: 320000,
      stockQty: 40,
    },
    {
      name: 'Assorted Buttons (Box of 2000)',
      slug: 'buttons-seed',
      description: 'Mixed designer buttons for tailoring.',
      brand: 'NH Trims',
      categoryId: trims.id,
      unit: ProductUnit.BOX,
      hsnCode: '9606',
      gstRatePercent: 12,
      moqQty: 1,
      pricePaise: 45000,
      stockQty: 130,
    },
  ];

  for (const s of seeds) {
    const product = await catalog(s);
    // Pune stocks everything at base price.
    await stock(pune.id, product.id, s.pricePaise, s.stockQty, s.tiers);
    // Mumbai stocks a subset at +8% with its own stock levels.
    if (s.inMumbai) {
      await stock(
        mumbai.id,
        product.id,
        bump(s.pricePaise),
        Math.round(s.stockQty * 0.6),
        s.tiers?.map((t) => ({ minQty: t.minQty, pricePaise: bump(t.pricePaise) })),
      );
    }
  }

  console.log('✅ Seed complete.');
  console.log('   Staff   → admin@nhstyx.com / Admin@123   ·   agent@nhstyx.com / Agent@123 (Pune)');
  console.log('   Customer→ phone 9876543210 / Customer@123 (Pune store)');
  console.log('   Stores  → Pune (all products) · Mumbai (subset, +8%)');
}

main()
  .catch((err) => {
    console.error('❌ Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
