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

  // --- Categories ---
  const apparel = await prisma.category.upsert({
    where: { slug: 'apparel' },
    update: {},
    create: { name: 'Apparel', slug: 'apparel', sortOrder: 1 },
  });
  const supplies = await prisma.category.upsert({
    where: { slug: 'store-supplies' },
    update: {},
    create: { name: 'Store Supplies', slug: 'store-supplies', sortOrder: 2 },
  });

  // --- Products (paise, GST-exclusive, with quantity tiers) ---
  await prisma.product.upsert({
    where: { slug: 'cotton-kurti-seed' },
    update: {},
    create: {
      name: "Women's Cotton Kurti",
      slug: 'cotton-kurti-seed',
      description: 'Breathable cotton kurti — wholesale pack.',
      brand: 'NH Basics',
      categoryId: apparel.id,
      unit: ProductUnit.PIECE,
      hsnCode: '6109',
      gstRatePercent: 5,
      mrpPaise: 79900, // ₹799.00
      pricePaise: 32000, // ₹320.00 base
      moqQty: 6,
      stockQty: 240,
      priceTiers: {
        create: [
          { minQty: 12, pricePaise: 30000 }, // ₹300 each at 12+
          { minQty: 50, pricePaise: 28000 }, // ₹280 each at 50+
        ],
      },
    },
  });

  await prisma.product.upsert({
    where: { slug: 'wooden-hanger-seed' },
    update: {},
    create: {
      name: 'Wooden Display Hanger (Pack of 50)',
      slug: 'wooden-hanger-seed',
      description: 'Premium wooden hangers for boutiques.',
      brand: 'NH Store',
      categoryId: supplies.id,
      unit: ProductUnit.PACK,
      hsnCode: '4421',
      gstRatePercent: 18,
      mrpPaise: 99900,
      pricePaise: 45000, // ₹450 / pack
      moqQty: 2,
      stockQty: 500,
      priceTiers: { create: [{ minQty: 10, pricePaise: 42000 }] },
    },
  });

  await prisma.product.upsert({
    where: { slug: 'poly-packaging-seed' },
    update: {},
    create: {
      name: 'Poly Packaging Covers (Box of 500)',
      slug: 'poly-packaging-seed',
      description: 'Transparent garment packaging covers.',
      brand: 'NH Store',
      categoryId: supplies.id,
      unit: ProductUnit.BOX,
      hsnCode: '3923',
      gstRatePercent: 18,
      pricePaise: 60000, // ₹600 / box
      moqQty: 1,
      stockQty: 300,
    },
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
