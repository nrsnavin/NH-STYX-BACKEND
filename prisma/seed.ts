import { PrismaClient, ProductUnit, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const hash = (plain: string) => bcrypt.hash(plain, 10);

async function main() {
  console.log('🌱 Seeding NH Styx database...');

  // --- Staff (User) ---
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
    update: {},
    create: {
      name: 'Field Agent One',
      email: 'agent@nhstyx.com',
      phone: '9000000002',
      password: await hash('Agent@123'),
      role: Role.AGENT,
    },
  });

  // --- Customer (shop owner) with address, credit terms, and a cart ---
  const customer = await prisma.customer.upsert({
    where: { phone: '9876543210' },
    update: {},
    create: {
      shopName: 'Trendy Threads Boutique',
      ownerName: 'Asha Verma',
      phone: '9876543210',
      email: 'asha@trendythreads.in',
      gstin: '27ABCDE1234F1Z5',
      password: await hash('Customer@123'),
      creditLimitPaise: 5_00_000, // ₹5,000
      creditDays: 30,
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
  console.log(`   Customer ${customer.shopName} ready.`);

  // --- Categories (Amazon-style tree: top-level + sub-categories) ---
  const cat = (
    name: string,
    slug: string,
    sortOrder: number,
    parentId?: string,
  ) =>
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

  // --- Products (paise, GST-exclusive, with quantity tiers) ---
  interface Tier {
    minQty: number;
    pricePaise: number;
  }
  const product = (p: {
    name: string;
    slug: string;
    description: string;
    brand: string;
    categoryId: string;
    unit: ProductUnit;
    hsnCode: string;
    gstRatePercent: number;
    mrpPaise?: number;
    pricePaise: number;
    moqQty: number;
    stockQty: number;
    tiers?: Tier[];
  }) =>
    prisma.product.upsert({
      where: { slug: p.slug },
      update: {},
      create: {
        name: p.name,
        slug: p.slug,
        description: p.description,
        brand: p.brand,
        categoryId: p.categoryId,
        unit: p.unit,
        hsnCode: p.hsnCode,
        gstRatePercent: p.gstRatePercent,
        mrpPaise: p.mrpPaise,
        pricePaise: p.pricePaise,
        moqQty: p.moqQty,
        stockQty: p.stockQty,
        priceTiers: p.tiers ? { create: p.tiers } : undefined,
      },
    });

  await product({
    name: "Women's Cotton Kurti",
    slug: 'cotton-kurti-seed',
    description: 'Breathable cotton kurti — wholesale pack.',
    brand: 'NH Basics',
    categoryId: kurtis.id,
    unit: ProductUnit.PIECE,
    hsnCode: '6109',
    gstRatePercent: 5,
    mrpPaise: 79900,
    pricePaise: 32000,
    moqQty: 6,
    stockQty: 240,
    tiers: [
      { minQty: 12, pricePaise: 30000 },
      { minQty: 50, pricePaise: 28000 },
    ],
  });
  await product({
    name: "Women's Rayon Printed Top",
    slug: 'rayon-top-seed',
    description: 'Trendy rayon tops, mixed prints.',
    brand: 'NH Basics',
    categoryId: kurtis.id,
    unit: ProductUnit.PIECE,
    hsnCode: '6106',
    gstRatePercent: 5,
    mrpPaise: 59900,
    pricePaise: 24000,
    moqQty: 10,
    stockQty: 320,
    tiers: [{ minQty: 50, pricePaise: 21000 }],
  });
  await product({
    name: 'Banarasi Silk Saree with Blouse',
    slug: 'silk-saree-seed',
    description: 'Festive Banarasi silk sarees with blouse piece.',
    brand: 'NH Ethnics',
    categoryId: sarees.id,
    unit: ProductUnit.PIECE,
    hsnCode: '5007',
    gstRatePercent: 5,
    mrpPaise: 249900,
    pricePaise: 120000,
    moqQty: 4,
    stockQty: 80,
    tiers: [{ minQty: 12, pricePaise: 110000 }],
  });
  await product({
    name: "Men's Formal Shirt (Pack of 5)",
    slug: 'mens-shirt-seed',
    description: 'Wrinkle-free formal shirts, assorted sizes.',
    brand: 'NH Formals',
    categoryId: menswear.id,
    unit: ProductUnit.PACK,
    hsnCode: '6205',
    gstRatePercent: 5,
    mrpPaise: 159900,
    pricePaise: 95000,
    moqQty: 2,
    stockQty: 150,
  });
  await product({
    name: 'Wooden Display Hanger (Pack of 50)',
    slug: 'wooden-hanger-seed',
    description: 'Premium wooden hangers for boutiques.',
    brand: 'NH Store',
    categoryId: hangers.id,
    unit: ProductUnit.PACK,
    hsnCode: '4421',
    gstRatePercent: 18,
    mrpPaise: 99900,
    pricePaise: 45000,
    moqQty: 2,
    stockQty: 500,
    tiers: [{ minQty: 10, pricePaise: 42000 }],
  });
  await product({
    name: 'Velvet Hangers (Pack of 100)',
    slug: 'velvet-hanger-seed',
    description: 'Non-slip velvet hangers, space-saving.',
    brand: 'NH Store',
    categoryId: hangers.id,
    unit: ProductUnit.PACK,
    hsnCode: '3926',
    gstRatePercent: 18,
    pricePaise: 78000,
    moqQty: 1,
    stockQty: 220,
  });
  await product({
    name: 'Poly Packaging Covers (Box of 500)',
    slug: 'poly-packaging-seed',
    description: 'Transparent garment packaging covers.',
    brand: 'NH Store',
    categoryId: covers.id,
    unit: ProductUnit.BOX,
    hsnCode: '3923',
    gstRatePercent: 18,
    pricePaise: 60000,
    moqQty: 1,
    stockQty: 300,
  });
  await product({
    name: 'Kraft Paper Carry Bags (Pack of 100)',
    slug: 'kraft-bags-seed',
    description: 'Eco-friendly branded carry bags.',
    brand: 'NH Store',
    categoryId: covers.id,
    unit: ProductUnit.PACK,
    hsnCode: '4819',
    gstRatePercent: 18,
    pricePaise: 35000,
    moqQty: 5,
    stockQty: 400,
    tiers: [{ minQty: 20, pricePaise: 32000 }],
  });
  await product({
    name: 'Printed Garment Tags (Pack of 1000)',
    slug: 'garment-tags-seed',
    description: 'Custom-printable hang tags with string.',
    brand: 'NH Store',
    categoryId: tags.id,
    unit: ProductUnit.PACK,
    hsnCode: '4821',
    gstRatePercent: 18,
    pricePaise: 28000,
    moqQty: 2,
    stockQty: 600,
  });
  await product({
    name: 'Female Retail Mannequin',
    slug: 'mannequin-seed',
    description: 'Full-body fibre mannequin for window display.',
    brand: 'NH Fixtures',
    categoryId: fixtures.id,
    unit: ProductUnit.PIECE,
    hsnCode: '9618',
    gstRatePercent: 18,
    mrpPaise: 499900,
    pricePaise: 320000,
    moqQty: 1,
    stockQty: 40,
  });
  await product({
    name: 'Assorted Buttons (Box of 2000)',
    slug: 'buttons-seed',
    description: 'Mixed designer buttons for tailoring.',
    brand: 'NH Trims',
    categoryId: trims.id,
    unit: ProductUnit.BOX,
    hsnCode: '9606',
    gstRatePercent: 12,
    pricePaise: 45000,
    moqQty: 1,
    stockQty: 130,
  });

  console.log('✅ Seed complete.');
  console.log('   Staff   → admin@nhstyx.com / Admin@123   ·   agent@nhstyx.com / Agent@123');
  console.log('   Customer→ phone 9876543210 / Customer@123');
}

main()
  .catch((err) => {
    console.error('❌ Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
