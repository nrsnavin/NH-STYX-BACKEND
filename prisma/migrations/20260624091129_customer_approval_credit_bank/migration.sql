-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "creditApproved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "rejectionReason" TEXT,
ADD COLUMN     "status" "CustomerStatus" NOT NULL DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "note" TEXT,
ADD COLUMN     "reference" TEXT;
