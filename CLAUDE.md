# CLAUDE.md — prisma-ms-docs

> Contexto interno para sesiones de Claude Code que trabajen **solo en este repo**. Este servicio es
> parte del sistema P.R.I.S.M.A. (apoyo a docentes chilenos para generar material/rúbricas adaptadas
> para estudiantes con NEE, bajo Decretos 170/2010, 83/2015 y 67/2018). El mapa completo del sistema
> vive en el CLAUDE.md raíz del workspace (`EP2/CLAUDE.md`); este archivo cubre solo el detalle interno
> de `prisma-ms-docs`.

---

## 1. Rol del repo

`prisma-ms-docs` es el microservicio de **documentos y jobs PACI**. Es **event-driven vía S3**: recibe
archivos del front, los sube a S3, y un trigger externo (Lambda, fuera de este repo) dispara el
procesamiento de IA. Este repo **no contiene lógica de IA** ni el endpoint que la Lambda invoca — solo
gestiona la subida, el estado (`schema jobs` en Postgres) y la descarga vía URL firmada.

Expone dos caminos que **no se cruzan entre sí** dentro de este código:

- **`/api/jobs/*`** — flujo asíncrono con persistencia en Postgres (tabla `jobs`) + sesión en DynamoDB.
> ⚠️ **Actualizado el 2026-10-02:** el módulo `chat` (`POST /api/chat/start`) fue **eliminado**: el BFF no lo ruteaba y el front no lo
> llamaba (verificado), así que era código muerto. Todo lo que este archivo dice más abajo sobre `chat/`, `ChatService` y `/api/chat/start`
> es histórico. La subida real es **`POST /api/jobs/upload`**, que además reserva el cupo de un solo flujo activo por docente
> (`DynamoService.acquireUserSlot`/`releaseUserSlot`, responde 409 `flow_in_progress`).

- **`/api/chat/*`** — solo `POST /api/chat/start`, crea una sesión de chat en DynamoDB y sube los
  archivos a S3, pero **no persiste nada en Postgres**. Es probablemente el punto de entrada real usado
  por el flujo HITL descrito en el CLAUDE.md raíz (aunque ese flujo, según el mapa general, va directo
  del front a `prisma_workflow` por proxy de Vite — ver §7 "Discrepancias" más abajo).

No crea usuarios ni conoce `SUPABASE_SERVICE_ROLE_KEY`: solo valida el JWT entrante contra el JWKS
público de Supabase (`SUPABASE_URL` + librería `jose`).

---

## 2. Stack y estructura

- **NestJS 10** + **Prisma 5** (`previewFeatures = ["multiSchema"]`), TypeScript, Jest, ESLint.
- AWS SDK v3: `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@aws-sdk/client-dynamodb`.
- Auth: `jose` (JWKS remoto, sin librería Supabase server-side; `@supabase/supabase-js` está en
  dependencies pero no se usa en `src/` — no se encontró ningún `import` de ese paquete).

```
src/
  app.controller.ts          # GET /api/health
  app.module.ts               # Imports: Config, Prisma, S3 (global), Chat, Jobs
  auth/
    auth.module.ts            # exporta SupabaseAuthGuard + RolesGuard
    decorators/roles.decorator.ts
    guards/supabase-auth.guard.ts   # valida JWT vía JWKS (jose)
    guards/roles.guard.ts           # compara user.appRole ?? user.role contra @Roles(...)
  chat/
    chat.controller.ts        # POST /api/chat/start
    chat.service.ts           # sube a S3 + crea sesión Dynamo IN-LINE (no usa DynamoService)
    dto/start-chat.dto.ts
  jobs/
    jobs.controller.ts        # upload/list/history/status/download/stats
    jobs.service.ts           # lógica de negocio de Job (Prisma) + Dynamo + S3
    dto/upload-job.dto.ts
    dto/list-jobs-query.dto.ts
  infrastructure/
    prisma/prisma.service.ts  # PrismaClient con onModuleInit/onModuleDestroy
    storage/s3.service.ts     # S3Module es @Global()
    dynamo/dynamo.service.ts  # createJobSession / listSessionsByUser
  main.ts                     # bootstrap: CORS, prefix "api", ValidationPipe, Swagger /docs
prisma/
  schema.prisma
  migrations/
    20260607000000_restructure_jobs_schema/
    20260617000001_add_colegio_id_to_jobs/
```

`S3Module` es el único módulo `@Global()`; `DynamoModule` y `PrismaModule` se importan explícitamente
donde se necesitan (`JobsModule` importa `DynamoModule`; `ChatModule` **no** lo importa — ver §8).

---

## 3. Modelo de datos (Prisma, `schema.prisma`)

Datasource Postgres con `schemas = ["jobs"]` (comparte instancia con otros microservicios, separado por
esquema — p. ej. Aiven, según convención del workspace).

```prisma
enum JobStatus { pending processing done error }
enum JobInputSource { uploaded_file json_form }

model Job {
  id                  String   @id @default(uuid()) @db.Uuid
  userId              String   @map("user_id")
  colegioId           String?  @map("colegio_id") @db.Uuid
  status              JobStatus @default(pending)
  inputSource         JobInputSource
  prompt              String   @db.Text
  paciObjectKey       String
  paciFileName        String?
  paciContentType     String
  planningObjectKey   String
  planningFileName    String
  planningContentType String
  generatedObjectKey  String?
  errorMessage        String?
  createdAt / updatedAt / startedAt / completedAt
}
```

- `@@map("jobs")` en el esquema `"jobs"` → tabla real `jobs.jobs`.
- Índices: `[userId, createdAt]`, `[colegioId]`, `[status]`.
- **Nada en este código transiciona el `status` de `pending` a `processing`/`done`.** Ese cambio de
  estado lo hace un proceso externo (presumiblemente `prisma_workflow` u otro componente escribiendo
  directo a la BD o vía un endpoint no presente en este repo) — no se encontró ningún endpoint interno
  de callback (`/internal/*`) en `src/`. Ver §7.
- `generatedObjectKey` es el que usa `GET /jobs/:id/download` para firmar la URL; si el job no está
  `done` o no tiene `generatedObjectKey`, la descarga falla (400 / 422).

Migraciones relevantes: `20260607000000_restructure_jobs_schema` (forma actual del modelo) y
`20260617000001_add_colegio_id_to_jobs` (agregó `colegioId` + índice, usado para stats/filtrado por
colegio).

---

## 4. Endpoints (`src/jobs/jobs.controller.ts`, `src/chat/chat.controller.ts`, `src/app.controller.ts`)

Todos bajo prefijo global `/api` (seteado en `main.ts`).

| Método | Ruta | Guard | Rol | Descripción |
|---|---|---|---|---|
| GET | `/api/health` | ninguno | — | Liveness simple (`{status:"ok"}`), sin prefijo de auth |
| POST | `/api/chat/start` | `SupabaseAuthGuard` | cualquiera | Sube `paci_file` + `material_file` (multipart) a S3, crea sesión en DynamoDB, devuelve `session_id`. No toca Postgres. |
| POST | `/api/jobs/upload` | `SupabaseAuthGuard` | cualquiera | Crea `Job` (Postgres) + sesión Dynamo + sube `paciFile`/`paciJson` y `planningFile` a S3. Devuelve `{jobId, status}` |
| GET | `/api/jobs` | `SupabaseAuthGuard`+`RolesGuard` | `ADMIN`\|`SUPERADMIN` | ⚠️ Pese al summary "Historial paginado de jobs (solo ADMIN)", internamente llama `findJobsByUser(user.id, query)` — **filtra por el propio `user.id` del admin autenticado**, no lista jobs de todos los usuarios. Ver §8. |
| GET | `/api/jobs/history` | `SupabaseAuthGuard` | cualquiera | Historial de sesiones del usuario **desde DynamoDB** (`listSessionsByUser`), no desde Postgres |
| GET | `/api/jobs/:id` | `SupabaseAuthGuard` | dueño del job | Estado actual del `Job` (Postgres), 404 si no es del usuario autenticado |
| GET | `/api/jobs/:id/download` | `SupabaseAuthGuard` | dueño del job | URL firmada S3 (`generatedObjectKey`), expira en `PACI_DOCUMENTS_URL_EXPIRES_IN` (default 900s). 400 si `status != done`, 422 si falta `generatedObjectKey` |
| GET | `/api/jobs/colegio/:colegioId/stats` | `SupabaseAuthGuard`+`RolesGuard` | `ADMIN`\|`SUPERADMIN` | Conteos por estado para un colegio. Si el rol es `ADMIN` (no `SUPERADMIN`), se exige `user.colegioId === colegioId` del JWT |
| GET | `/api/jobs/colegio/:colegioId/jobs` | `SupabaseAuthGuard` | **cualquiera autenticado** | ⚠️ Sin `RolesGuard` ni verificación de que el usuario pertenezca a ese colegio — cualquier usuario autenticado puede pedir jobs de cualquier `colegioId`. Ver §8. |

No existe ningún endpoint `/internal/run` ni protegido por `INTERNAL_TOKEN` en este repo — ver §7.

Swagger disponible en `/docs` (con `.addBearerAuth()` y `.addServer("/api")`).

---

## 5. Integración con AWS

### S3 (`src/infrastructure/storage/s3.service.ts`)
- Cliente `@aws-sdk/client-s3`, lazy-init (`getClientAndBucket()`), credenciales explícitas
  (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`) — no usa IAM role implícito.
- Bucket: `S3_BUCKET` (o fallback `PACI_DOCUMENTS_BUCKET`, no documentado en `.env.example`).
- `forcePathStyle` viene de `AWS_S3_FORCE_PATH_STYLE === "true"` (comparación de string, no boolean).
- `uploadObject()` → `PutObjectCommand` simple (no multipart/streaming, todo en memoria como `Buffer`
  porque Multer usa `FileFieldsInterceptor` sin `dest`, es decir, memoryStorage).
- `createSignedDownloadUrl()` → `getSignedUrl` con `GetObjectCommand`, expiración configurable.
- **Convención de keys S3**: `jobs/{id}/paci{ext}` y `jobs/{id}/material{ext}` (jobs) o
  `jobs/{id}/material.docx` (chat, siempre `.docx` fijo). Ambos flujos (`jobs` y `chat`) comparten el
  mismo prefijo `jobs/` en el bucket, distinguidos solo por el UUID (`job.id` vs `session_id` random).

### DynamoDB
- **Dos implementaciones distintas y no compartidas** de lo mismo (ver gotcha en §8):
  - `src/infrastructure/dynamo/dynamo.service.ts` (`DynamoService`, usado por `JobsService`): escribe
    un ítem rico (`messages`, `hitl_data`, `error`, `docx_s3_key`, `workflow_status`, `expires_at` TTL a
    7 días) — esquema alineado con lo que `prisma_workflow` probablemente lee/actualiza durante el chat
    HITL (campos `workflow_status`, `hitl_data`, `docx_s3_key` no los escribe nunca este servicio, solo
    los inicializa vacíos/null).
  - `src/chat/chat.service.ts` (inline, sin usar `DynamoService`): escribe un ítem más simple (sin
    `messages`, `hitl_data`, `workflow_status`, sin TTL `expires_at`) y además implementa su propio
    rollback (`deleteSessionRecord`) si falla la subida a S3 — cosa que `JobsService.createUploadJob` NO
    hace (si falla el upload después de crear la sesión Dynamo, la sesión Dynamo queda huérfana; solo el
    `Job` en Postgres se marca `error`).
- Tabla: `DYNAMO_TABLE` (fallback `CHAT_SESSIONS_TABLE`, no documentado en `.env.example`).
- `AWS_DYNAMODB_ENDPOINT` opcional (para DynamoDB local).
- `listSessionsByUser` hace un **`ScanCommand`** con `FilterExpression` sobre toda la tabla (no Query
  por índice) — no escala bien si la tabla crece; es O(n) sobre todos los ítems.

### Lambda / trigger externo
No hay código de Lambda en este repo (vive en `prisma_workflow/lambda/trigger_handler.py`, otro repo).
Este servicio solo **provoca** el trigger subiendo el `PUT` a S3 después de asegurar que la sesión
DynamoDB ya existe (ver comentario explícito en `jobs.service.ts` línea ~79: *"DynamoDB must exist
before S3 uploads — the Lambda fires on the first PUT and needs to find the session record already in
DynamoDB"*). El orden **Dynamo → S3** es intencional y crítico; invertirlo rompe el flujo Lambda.

---

## 6. Autenticación y roles

- `SupabaseAuthGuard` (`src/auth/guards/supabase-auth.guard.ts`): exige header `Authorization: Bearer
  <jwt>`, valida contra `createRemoteJWKSet(SUPABASE_URL + "/auth/v1/.well-known/jwks.json")` con
  `jwtVerify` (audience `"authenticated"`). Puebla `request.user` con `{ id: payload.sub, email, role
  (claim top-level), appRole (payload.app_metadata.role), colegioId (payload.app_metadata.colegioId) }`.
- `RolesGuard` (`src/auth/guards/roles.guard.ts`) + `@Roles(...)`: compara **`user.appRole ?? user.role`**
  contra la lista de roles requeridos. Es decir, prioriza el rol en `app_metadata` sobre el claim
  `role` estándar de Supabase (que normalmente es `"authenticated"`) — si `app_metadata.role` no está
  seteado en el usuario de Supabase, el guard efectivamente compara contra `"authenticated"`, que nunca
  matcheará `ADMIN`/`SUPERADMIN`.
- Roles usados en este repo: `"ADMIN"`, `"SUPERADMIN"` (constante `ADMIN_ROLES` en
  `jobs.controller.ts`). Esto no calza 1:1 con el enum `UserRole` (`ADMIN`/`TEACHER`) de `ms-users`
  descrito en el CLAUDE.md raíz del workspace — no existe `SUPERADMIN` allí. Confirmar si `app_metadata`
  realmente puebla `"SUPERADMIN"` en algún flujo, o si es un rol muerto/aspiracional en este repo.

---

## 7. Flujo event-driven del job (paso a paso)

1. Front (`prisma-front`, o el BFF `bff-prisma` si está delante) llama `POST /api/jobs/upload`
   (multipart: `prompt`, y `paciJson` **o** `paciFile`, más `planningFile` obligatorio) con JWT.
2. `JobsService.createUploadJob`:
   a. Valida y crea `Job` en Postgres con `status=pending`.
   b. Crea la sesión en DynamoDB (`DynamoService.createJobSession`) — **debe ir antes del S3 upload**.
   c. Sube PACI y material a S3 bajo `jobs/{job.id}/...`.
   d. Si algo falla en (b) o (c), marca el `Job` como `status=error` con `errorMessage`, pero **no**
      revierte la sesión Dynamo si ya se creó (a diferencia de `ChatService`, que sí hace rollback).
3. El `PUT` a S3 dispara la Lambda externa (`prisma_workflow/lambda/trigger_handler.py`), que according
   al mapa del workspace llama `POST /internal/run/{session_id}` — **ese endpoint vive en
   `prisma_workflow` (FastAPI :8000), no en este repo**. Este servicio no expone ni protege ningún
   endpoint `/internal/*`.
4. En algún punto externo a este código, el `Job.status` debería pasar a `processing` y luego a
   `done`/`error`, y `generatedObjectKey` debería poblarse con la clave S3 del `.docx` resultante. **No
   hay evidencia en `src/` de qué proceso hace ese UPDATE** — probablemente `prisma_workflow` escribe
   directo a la tabla Postgres (`schema jobs`) compartiendo `DATABASE_URL`, dado que este repo no expone
   ningún endpoint de callback. Si se necesita confirmar, revisar `prisma_workflow`.
5. Front consulta `GET /api/jobs/:id` para poll de estado y `GET /api/jobs/:id/download` para obtener
   la URL firmada una vez `done`.

### Flujo de chat (`POST /api/chat/start`)
Sube `paci_file` + `material_file` a S3 (`jobs/{session_id}/...`) y crea sesión en DynamoDB directamente
desde `ChatService` (sin pasar por Postgres ni por `DynamoService`). No hay otros endpoints de chat en
este repo — el resto del ciclo HITL (mensajes, aprobación, streaming del `.docx`) ocurre, según el mapa
del workspace, directo entre el front y `prisma_workflow` (proxy de Vite), sin pasar por `ms-docs`. Este
único endpoint (`/api/chat/start`) puede ser vestigial, un camino alternativo, o estar detrás del BFF
(`bff-prisma`, puerto 3010) — no se encontró en este repo ninguna referencia a un BFF (ni imports ni
menciones en config), por lo que si existe una integración con él debe darse desde afuera de este repo.

---

## 8. Variables de entorno (`.env.example`)

```env
NODE_ENV=development
PORT=3000
CORS_ORIGIN=http://localhost:3002,http://127.0.0.1:3002

DATABASE_URL=postgresql://user:password@host:port/database?sslmode=require

# Solo SUPABASE_URL es necesaria para validar JWT via JWKS (jose).
# Los microservicios NO deben tener SUPABASE_ANON_KEY ni SUPABASE_SERVICE_ROLE_KEY.
SUPABASE_URL=https://your-project.supabase.co

AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your-aws-access-key-id
AWS_SECRET_ACCESS_KEY=your-aws-secret-access-key
AWS_S3_FORCE_PATH_STYLE=false
S3_BUCKET=your-s3-bucket-name
PACI_DOCUMENTS_URL_EXPIRES_IN=900
JOB_UPLOAD_MAX_SIZE_MB=25

DYNAMO_TABLE=chat_sessions
CHAT_SESSION_DEFAULT_SCHOOL_ID=colegio_demo
AWS_DYNAMODB_ENDPOINT=
INTERNAL_TOKEN=your-internal-token
BD_LOGS=postgresql+asyncpg://user:password@host/database?ssl=require
```

⚠️ **`INTERNAL_TOKEN`, `JOB_UPLOAD_MAX_SIZE_MB` y `BD_LOGS` están declaradas en `.env.example` pero no
se leen en ningún lugar de `src/`** (`grep` sin resultados). Ver §9 para el detalle de cada una.

---

## 9. Comandos

```bash
npm install
npm run prisma:generate          # genera cliente Prisma
npm run prisma:migrate:dev       # migración en desarrollo
npm run prisma:migrate:deploy    # aplica migraciones (producción; también se corre aparte del build Docker)
npm run prisma:db:push           # push directo del schema (sin migración)
npm run prisma:studio            # Prisma Studio

npm run start:dev                # watch mode, puerto 3000 (alias: npm run dev)
npm run start:prod               # node dist/main.js
npm run build                    # nest build

npm test                         # Jest
npm run test:watch
npm run test:cov
npm run lint                     # eslint --fix
```

Tests existentes: `src/jobs/jobs.controller.spec.ts`, `src/jobs/jobs.service.spec.ts`,
`src/chat/chat.controller.spec.ts`, `src/chat/chat.service.spec.ts`.

Docker: build multi-stage (`Dockerfile`), corre migraciones **fuera** de la imagen (`npx prisma migrate
deploy` como paso aparte del deploy, porque `prisma` está en `devDependencies` y el stage runtime hace
`npm ci --omit=dev`). CI en `.github/workflows/deploy-ecr.yml` (build/push a ECR).

---

## 10. Gotchas / cosas no obvias

1. **No existe `/internal/run` ni protección por `INTERNAL_TOKEN` en este repo.** Esa ruta vive en
   `prisma_workflow` (FastAPI). `INTERNAL_TOKEN` está en `.env.example` de este repo pero no se usa en
   `src/` — probablemente copiado del `.env` de referencia del workspace o reservado para una futura
   ruta de callback que hoy no existe. No asumir que protege algo aquí.
2. **`BD_LOGS` (connection string `asyncpg`) tampoco se usa en `src/`.** Es una URL de conexión async de
   Python (`postgresql+asyncpg://...`), estilísticamente ajena a NestJS/Prisma — es casi seguro que es
   una variable pensada para `prisma_workflow` (Python) copiada por error/consistencia a este
   `.env.example`.
3. **`JOB_UPLOAD_MAX_SIZE_MB` no está conectado al límite real.** El límite de subida (25MB) está
   **hardcodeado** en `FileFieldsInterceptor(..., { limits: { fileSize: 25 * 1024 * 1024 } })` tanto en
   `jobs.controller.ts` como en `chat.controller.ts`. Cambiar la env var no tiene ningún efecto; hay que
   tocar el código en ambos controllers.
4. **`ChatService` duplica la lógica de `DynamoService` en vez de reusarla** (`ChatModule` no importa
   `DynamoModule`). Tiene su propio `DynamoDBClient`, su propio `PutItemCommand`/`DeleteItemCommand`, y
   un esquema de ítem más pobre (sin `messages`, `hitl_data`, `workflow_status`, sin TTL `expires_at`).
   Si se necesita agregar un campo al ítem de sesión, hay que tocarlo en dos lugares.
5. **`GET /api/jobs` no es lo que su Swagger dice.** Documentado como "Historial paginado de jobs (solo
   ADMIN/SUPERADMIN)" pero filtra por `findJobsByUser(user.id, ...)` — devuelve los jobs del **propio**
   admin autenticado, no un historial global. Si se quiere un historial admin real, revisar si falta
   implementar o si el nombre/doc está mal.
6. **`GET /api/jobs/colegio/:colegioId/jobs` no tiene `RolesGuard` ni verificación de pertenencia al
   colegio** (a diferencia de `.../stats`, que sí exige `ADMIN` y compara `colegioId`). Cualquier usuario
   autenticado (rol docente incluido) puede consultar jobs de cualquier colegio pasando el UUID. Revisar
   si es intencional antes de exponerlo en producción.
7. **Orden Dynamo → S3 es obligatorio, no cosmético**, tanto en `JobsService.createUploadJob` como en
   `ChatService.startChat`: la Lambda dispara con el primer `PUT` a S3 y espera encontrar la sesión ya
   creada en DynamoDB. Invertir el orden rompe silenciosamente el flujo (la Lambda no encontraría la
   sesión).
8. **`JobsService.createUploadJob` no hace rollback de la sesión DynamoDB si el S3 upload falla**
   (a diferencia de `ChatService.startChat`, que sí borra la sesión Dynamo en el `catch`). Puede dejar
   sesiones Dynamo huérfanas asociadas a un `Job` en estado `error`.
9. **`PACI_DOCUMENTS_URL_EXPIRES_IN` se lee con `configService.get<number>(...)`** pero no hay
   `ConfigModule` con `validationSchema`/transformación — el genérico `<number>` es solo un cast de
   TypeScript, en runtime probablemente llega como `string` desde `process.env`. Si `getSignedUrl`
   recibe un string en `expiresIn`, verificar el comportamiento real (AWS SDK puede coercionar o fallar
   silenciosamente); no asumir que siempre es un `number` real.
10. **`RolesGuard` usa `user.appRole ?? user.role`**: si el usuario de Supabase no tiene
    `app_metadata.role` seteado, cae al claim `role` estándar del JWT (típicamente `"authenticated"`),
    que nunca matcheará `ADMIN`/`SUPERADMIN`. Un admin sin `app_metadata.role` correctamente configurado
    en Supabase quedará bloqueado de los endpoints admin de este servicio sin un mensaje obvio (solo
    "Role 'authenticated' is not authorized").
11. **`listSessionsByUser` (DynamoDB) usa `ScanCommand` con `FilterExpression`**, no una Query por
    índice — recorre toda la tabla `DYNAMO_TABLE` en cada llamada a `GET /api/jobs/history`. Con
    volumen alto de sesiones esto es costoso y lento; considerar un GSI por `user_id` si se vuelve
    cuello de botella.
12. **`@supabase/supabase-js` está en `dependencies` pero no se usa en `src/`.** Es dependencia muerta
    o vestigial (coherente con que este servicio no debe tener `SUPABASE_SERVICE_ROLE_KEY` ni crear
    usuarios) — no agregar lógica que dependa de este paquete sin revisar antes si realmente se necesita
    aquí (la validación de JWT ya la cubre `jose` directamente).
13. **No hay `bff-prisma` referenciado en este repo.** Si en el futuro el front deja de llamar
    directo a `ms-docs` y pasa por un BFF, revisar `CORS_ORIGIN` (hoy apunta a `localhost:3002`, el
    front, no a un puerto de BFF como 3010) y confirmar que el JWT que reenvía el BFF siga siendo el
    JWT original de Supabase (este guard no acepta ningún otro esquema de auth).
