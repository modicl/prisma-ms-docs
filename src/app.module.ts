import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AppController } from "./app.controller";
import { JobsModule } from "./jobs/jobs.module";
import { PrismaModule } from "./infrastructure/prisma/prisma.module";
import { S3Module } from "./infrastructure/storage/s3.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    S3Module,
    JobsModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
