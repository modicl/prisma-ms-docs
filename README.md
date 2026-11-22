# prisma-ms-docs

Microservicio de documentos y jobs PACI de P.R.I.S.M.A. Recibe los archivos del docente, los sube a S3, registra el job en PostgreSQL y crea la sesión en DynamoDB. Con eso se dispara el procesamiento de IA, que ocurre en otro servicio.

## Qué hace

- `POST /api/jobs/upload`: valida el archivo, crea el job (`pending`), crea la sesión en DynamoDB y sube el archivo a S3 bajo `jobs/{id}/`. Reserva el cupo de un solo flujo activo por docente y responde 409 `flow_in_progress` si ya existe uno.
- Listado, historial, estado, estadísticas y descarga de jobs (URL firmada de S3).
- No contiene lógica de IA: el evento de S3 llega a SQS, una Lambda arranca Step Functions y esa orquestación llama a `prisma_workflow`.

El orden es obligatorio: primero la sesión en DynamoDB y después el archivo en S3, porque el evento de S3 dispara el flujo y espera encontrar la sesión.

## Autenticación

Valida el ID token de Amazon Cognito con JWKS (`jose`) y aplica roles por lista blanca sobre `cognito:groups` con `RolesGuard`. El colegio se lee de `custom:colegioId`.

## Stack

NestJS 10, Prisma 5 (`multiSchema`, esquema `jobs`), AWS SDK v3 (S3, DynamoDB). Puerto 3000.

## Configuración

| Variable | Descripción |
|---|---|
| `DATABASE_URL` | PostgreSQL. |
| `COGNITO_REGION`, `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID` | Validación de tokens. |
| `S3_BUCKET`, `AWS_REGION` | Bucket de jobs (en AWS se usa el rol de la tarea, sin claves). |
| `DYNAMO_TABLE` | Tabla de sesiones. |
| `JOB_UPLOAD_MAX_SIZE_MB`, `PACI_DOCUMENTS_URL_EXPIRES_IN` | Límite de subida y vigencia de las URL firmadas. |
| `INTERNAL_TOKEN` | Secreto compartido con el workflow. |

## Ejecución y pruebas

```bash
npm install
npx prisma generate
npx prisma migrate deploy
npm run dev
npm test
```

## Despliegue

Imagen en ECR (`api/msdocs`), contenedor de la tarea ECS `prisma-app`.
