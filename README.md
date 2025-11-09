# IaC Agent Solution

Este proyecto implementa un **Agente de IaC (Infrastructure as Code) para Terraform en Azure**, compuesto por:

- **Frontend (App Service)**: Interfaz web para interactuar con el agente.
- **Backend (Function App)**: Proxy seguro que conecta el frontend con la **Agents API** de Azure AI Foundry.

---

## 📂 Estructura del repositorio

```Shell
iac-agent-solution/
├─ front/          # Código del App Service (HTML, CSS, JS)
│  ├─ index.html   # Interfaz principal con diseño centrado y CORS configurado
│  └─ assets/      # (Opcional) CSS/JS adicionales
└─ back/           # Código de la Azure Function (Node.js)
   ├─ host.json
   ├─ package.json
   ├─ iac-agent/
   │  ├─ function.json
   │  └─ index.js   # Lógica del proxy con Managed Identity + RBAC

```

---

## ✅ Funcionalidad implementada

### Frontend

- Interfaz moderna con: 
    - Área de texto con placeholder dinámico.
    - Botón **Enviar** y **Reset** (reinicia conversación).
    - Estado visual (`OK`, `Error`, `Consultando…`).
    - Persistencia de `threadId` en `localStorage` para mantener contexto.
- Conexión al backend vía `fetch`: 
    - Envía `{ prompt, threadId }`.
    - Recibe `{ status, threadId, runId, output }`.

### Backend

- Azure Function con: 
    - Autenticación mediante **Managed Identity** (DefaultAzureCredential).
    - Llamadas a la **Agents API**: 
        - `POST /threads/runs` (primer turno).
        - `POST /threads/{id}/messages` + `POST /threads/{id}/runs` (turnos siguientes).
        - `GET /threads/{id}/messages` para obtener la respuesta.
    - Manejo de CORS (`Access-Control-Allow-Origin` configurable).
    - Health check (`?health=1`) y diagnóstico (`?diag=1`).
- Variables de entorno: 
    - `FOUNDRY_PROJECT_ENDPOINT` → Endpoint del proyecto Foundry.
    - `AGENT_ID` → ID del agente IaC.
    - `CORS_ORIGIN` → Dominio del frontend.
    - `TIMEOUT_MS` → Tiempo máximo para polling.

---

## 🔐 Seguridad

- **RBAC**: La Managed Identity de la Function tiene rol **Azure AI Developer** en el AI Project.
- **CORS**: Configurado para permitir solo el origen del App Service.
- **Sin API Key en el frontend**: El backend usa token Entra ID, no claves expuestas.

---

## 🚀 Despliegue

### Frontend (App Service)

1. Sube el contenido de `front/` a `D:\home\site\wwwroot` (o usa ZIP Deploy).
2. Configura el dominio en `CORS_ORIGIN` del backend.

### Backend (Function App)

1. Sube `back/` a `wwwroot` (estructura correcta con carpeta `iac-agent`).
2. Ejecuta:

```Shell
npm install

```

1. Configura App Settings:

```Shell
FUNCTIONS_WORKER_RUNTIME = node
FOUNDRY_PROJECT_ENDPOINT = https://<aiservices-id>.services.ai.azure.com/api/projects/<project-name>
AGENT_ID = <ID-del-agente>
CORS_ORIGIN = https://<tu-app-service>.azurewebsites.net

```

1. Activa **Managed Identity** y asigna rol en el AI Project.

---

## 🧪 Pruebas

- **Health**:

```Shell
GET https://<function-app>.azurewebsites.net/api/iac-agent?code=<KEY>&health=1

```

- **Prompt**:

```Shell
POST https://<function-app>.azurewebsites.net/api/iac-agent?code=<KEY>
Body: { "prompt": "Genera Terraform para un RG y VNet en Canada Central", "threadId": null }

```

---

## ✅ Próximos pasos

- Integrar **App Service Authentication (AAD)** para eliminar `?code`.
- Añadir **historial visual** y botón **Copiar HCL** en el frontend.
- Configurar **CI/CD** con GitHub Actions para App Service y Function App.
