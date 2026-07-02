# Helios Gateway

Helios Gateway es el componente operativo del ecosistema Helios. Su responsabilidad es servir como el "sistema nervioso" entre la bandeja de atención de Chatwoot y el cerebro de inteligencia artificial (Hermes).

## Funciones Principales

- **Idempotencia:** Evita que el mismo mensaje sea procesado más de una vez.
- **Buffer de Mensajes (Ráfagas):** Agrupa mensajes del mismo usuario que lleguen con menos de 5 segundos de diferencia, consolidando sus contenidos en un único payload para Hermes.
- **Preparación de Contexto:** Reúne en tiempo real los perfiles del paciente, estados de la conversación y casos de financiamiento activos en Supabase.
- **Ejecutor de Herramientas (Tool Runner):** Procesa los llamados a la API de Chatwoot (respuestas, notas privadas, asignación a humanos y etiquetas) y base de datos (actualización de perfiles, estados y casos).

---

## Requisitos Previos

- Node.js >= 20.x
- Cuenta o instancia de Supabase activa.

---

## Configuración y Setup

1. **Clonar/Ubicar el directorio** e instalar dependencias:
   ```bash
   npm install
   ```

2. **Configurar el Entorno:**
   Copia el archivo `.env.example` a `.env` y rellena las variables de conexión a Supabase y Chatwoot.
   ```bash
   cp .env.example .env
   ```

3. **Aplicar la Migración SQL:**
   Copia el contenido del archivo ubicado en `/migrations/001_helios_gateway_schema.sql` y pégalo en el **SQL Editor** de tu panel de Supabase para crear las 7 tablas del sistema e índices necesarios.

---

## Scripts Disponibles

- **`npm run dev`**: Levanta el servidor en modo desarrollo con recarga en caliente utilizando `tsx`.
- **`npm run build`**: Compila el código TypeScript a JavaScript en la carpeta `dist`.
- **`npm run start`**: Ejecuta el servidor compilado en entornos de producción.

---

## Endpoints Principales

- **`GET /health`**: Verifica que el servicio responda correctamente.
- **`POST /webhooks/chatwoot`**: Endpoint al que debe apuntar el webhook de tu cuenta de Chatwoot.
- **`POST /test/chatwoot-message`**: Permite simular el envío de un mensaje de un paciente al webhook sin necesidad de configurar Chatwoot.
  - Ejemplo de payload:
    ```json
    {
      "phone": "+584121234567",
      "text": "Hola, ¿tienen disponibilidad de citas mañana?",
      "conversation_id": "23",
      "contact_id": "7"
    }
    ```
- **`POST /admin/reactivate-ai`**: Reactiva la IA en una conversación específica (pone `ai_enabled` a `true`).
- **`POST /admin/disable-ai`**: Pausa la IA para una conversación específica (pone `ai_enabled` a `false`).
