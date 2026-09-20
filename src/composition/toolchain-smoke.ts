import 'reflect-metadata';

import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ExpressAdapter } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import express from 'express';
import jwt from 'jsonwebtoken';
import { MongoClient } from 'mongodb';

@Module({})
export class ToolchainSmokeModule {}

export const toolchainBaseline = Object.freeze({
  nestFactory: typeof NestFactory.create,
  expressAdapter: typeof ExpressAdapter,
  jwtModule: typeof JwtModule.register,
  swaggerModule: typeof SwaggerModule.setup,
  express: typeof express,
  jsonwebtoken: typeof jwt.sign,
  mongoClient: typeof MongoClient,
});
