CREATE TYPE "DriveCostPaymentStatus" AS ENUM ('UNPAID', 'PAID');

ALTER TABLE "DriveCost"
ADD COLUMN "paymentStatus" "DriveCostPaymentStatus" NOT NULL DEFAULT 'UNPAID';
