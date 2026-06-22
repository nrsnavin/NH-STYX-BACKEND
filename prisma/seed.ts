import { PrismaClient, UserRole, UserStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const hash = (plain: string) => bcrypt.hash(plain, 10);

async function main() {
  console.log('🌱 Seeding NH Styx database...');

  // --- Admin ---
  const admin = await prisma.user.upsert({
    where: { email: 'admin@nhstyx.com' },
    update: {},
    create: {
      email: 'admin@nhstyx.com',
      passwordHash: await hash('Admin@123'),
      fullName: 'NH Styx Admin',
      role: UserRole.ADMIN,
      status: UserStatus.ACTIVE,
    },
  });

  // --- Agent ---
  const agent = await prisma.user.upsert({
    where: { email: 'agent@nhstyx.com' },
    update: {},
    create: {
      email: 'agent@nhstyx.com',
      passwordHash: await hash('Agent@123'),
      fullName: 'Field Agent One',
      role: UserRole.AGENT,
      status: UserStatus.ACTIVE,
      agentProfile: {
        create: { employeeCode: 'AGT-0001', region: 'South' },
      },
    },
    include: { agentProfile: true },
  });

  // --- Customer (boutique owner) ---
  await prisma.user.upsert({
    where: { email: 'customer@nhstyx.com' },
    update: {},
    create: {
      email: 'customer@nhstyx.com',
      passwordHash: await hash('Customer@123'),
      fullName: 'Boutique Owner',
      role: UserRole.CUSTOMER,
      status: UserStatus.ACTIVE,
      customerProfile: {
        create: {
          businessName: 'Trendy Threads Boutique',
          businessType: 'Boutique',
          gstNumber: '29ABCDE1234F1Z5',
          agentId: agent.agentProfile?.id,
          cart: { create: {} },
        },
      },
    },
  });

  // --- Catalog: categories ---
  const apparel = await prisma.category.upsert({
    where: { slug: 'apparel' },
    update: {},
    create: { name: 'Apparel', slug: 'apparel', description: 'Clothing & garments' },
  });
  const supplies = await prisma.category.upsert({
    where: { slug: 'store-supplies' },
    update: {},
    create: {
      name: 'Store Supplies',
      slug: 'store-supplies',
      description: 'Hangers, tags, packaging & fixtures',
    },
  });

  // --- Catalog: products with variants ---
  await prisma.product.upsert({
    where: { slug: 'cotton-kurti-seed' },
    update: {},
    create: {
      name: "Women's Cotton Kurti",
      slug: 'cotton-kurti-seed',
      description: 'Breathable cotton kurti — wholesale pack.',
      brand: 'NH Basics',
      categoryId: apparel.id,
      variants: {
        create: [
          { sku: 'KURTI-RED-M', size: 'M', color: 'Red', price: 320, mrp: 799, minOrderQty: 6, stockQuantity: 240 },
          { sku: 'KURTI-RED-L', size: 'L', color: 'Red', price: 320, mrp: 799, minOrderQty: 6, stockQuantity: 180 },
          { sku: 'KURTI-BLU-M', size: 'M', color: 'Blue', price: 320, mrp: 799, minOrderQty: 6, stockQuantity: 200 },
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
      variants: {
        create: [
          { sku: 'HNG-WD-50', price: 450, mrp: 999, minOrderQty: 2, stockQuantity: 500 },
        ],
      },
    },
  });

  console.log('✅ Seed complete.');
  console.log('   Admin:    admin@nhstyx.com / Admin@123');
  console.log('   Agent:    agent@nhstyx.com / Agent@123');
  console.log('   Customer: customer@nhstyx.com / Customer@123');
}

main()
  .catch((err) => {
    console.error('❌ Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
