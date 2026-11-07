# RUNBOOK: Corrida Desatendida de 12 Horas en Docker (S4)

> **Documento Operativo Oficial — Reto Agente 2026 (Semana 4)**  
> Guía paso a paso para la preparación, ejecución, monitoreo hora a hora, detección de anomalías y conciliación financiera de la corrida desatendida de 12 horas y 1.150 unidades de trabajo del Rastreador de Oportunidades en SECOP II utilizando Docker Compose o CLI directa.

---

## 1. Lista de Verificación del Host (Windows)

Antes de iniciar la ventana de ejecución de 12 horas, verifique los siguientes puntos en la máquina anfitriona:

- [ ] **Plan de Energía (Suspender: NUNCA)**:
  - Vaya a *Configuración > Sistema > Inicio/apagado y suspensión*.
  - En las opciones con alimentación de CA, configure **"Al estar enchufado, suspender el equipo después de: NUNCA"**.
  - *(Opcional)*: Puede permitir que la pantalla se apague, pero el sistema debe permanecer activo.
- [ ] **Conexión Eléctrica**:
  - El equipo debe estar permanentemente conectado a la corriente eléctrica (cargador/AC).
- [ ] **Docker Desktop Activo y Configurado**:
  - Asegúrese de que Docker Desktop esté iniciado y con el backend WSL 2 activo.
  - Habilite el inicio automático en *Docker Desktop > Settings > General > "Start Docker Desktop when you log in"*.
  - Verifique que Docker disponga de recursos adecuados (al menos 4 GB de RAM y 2 vCPUs recomendados en `.wslconfig`).
- [ ] **Pausar Actualizaciones y Reinicios de Windows**:
  - Vaya a *Configuración > Windows Update*.
  - Haga clic en **"Pausar actualizaciones durante 1 semana"** para evitar reinicios intempestivos durante la ventana de 12 horas.
- [ ] **Estabilidad de Red**:
  - Verifique que la conexión a Internet sea estable, sin límites de datos o desconexiones forzadas por VPN.
  - Debe existir acceso libre al gateway oficial (`api.reto.pltk.mx`) y a los datos abiertos de Socrata (`datos.gov.co`).
- [ ] **Espacio en Disco**:
  - Compruebe que la unidad donde se ubica el proyecto disponga de al menos **10 GB de espacio libre** para albergar imágenes, capas de Docker, reportes y bitácoras.

---

## 2. Preparación para Arranque Limpio (*Clean Start*) y Pre-flight

### 2.1. Archivado de Ensayos Previos (Obligatorio)
Para garantizar que la corrida real empiece con un estado persistente completamente limpio (sin mezclar tareas ni métricas de ensayos anteriores):
```powershell
pnpm carga:archivar-ensayos
```
*Este comando **mueve** (nunca borra) los archivos de ensayo (`estado.json`, `bitacora-tareas.*`, `eventos.jsonl`, etc.) hacia una subcarpeta fechada bajo `data/pruebas-reto/carga/ensayos/<timestamp>/`.*

### 2.2. Verificación Pre-flight
Ejecute la verificación previa de 12 puntos de control:
```powershell
pnpm preflight
```
*Debe obtener **`DICTAMEN: GO`** en verde antes de proceder.*

---

## 3. Configuración del Entorno de Carga

1. Configure las siguientes variables en su archivo local `.env` (el cual reside en la raíz y está protegido en `.gitignore`):

   ```env
   # Configuración oficial para la corrida desatendida de 12 horas (S4-FINAL)
   DAEMON_FUENTE=historico
   DAEMON_UNIDADES=1050
   DAEMON_HORAS=12.5
   DAEMON_HORAS_MINIMAS=12.2
   DAEMON_LOTE=6
   DAEMON_CONCURRENCIA=3
   DAEMON_PRESUPUESTO_TOKENS=17100000
   DAEMON_IGNORAR_PROYECCION=false
   DAEMON_DRY_RUN=false
   ```

2. **Advertencia de Seguridad Estricta**:
   > [!CAUTION]
   > **NUNCA** ejecute comandos que impriman valores de entorno resueltos en pantalla (`docker compose config`, `docker inspect`, `printenv`, `env`), ya que expondrían su llave privada `RETO_KEY` en los registros.
   > **NUNCA** copie el archivo `.env` dentro de la imagen de Docker (la plantilla `.dockerignore` ya lo protege).

---

## 4. Comandos de Lanzamiento Operativo

### 4.1. Opción A: Despliegue Automatizado con Scripts Oficiales (Recomendado para el Reto)

1. **Lanzador Oficial**:
   Ejecute el script interactivo de lanzamiento en PowerShell:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\lanzar-carga.ps1
   ```
   *El script automatiza los 6 pasos críticos de preparación:*
   - Ejecuta `pnpm preflight` (aborta si hay veredicto NO-GO; la llamada de prueba al modelo ocurre **antes** de fijar la línea base del panel).
   - Confirma y ejecuta `pnpm carga:archivar-ensayos` para arrancar con directorio de evidencias completamente limpio.
   - Solicita interactivamente los números de la línea base del panel (`requests`, `input tokens`, `output tokens`, `cost USD`) y genera `data/pruebas-reto/carga/panel-lanzamiento.json`.
   - Escribe `data/pruebas-reto/carga/lanzamiento.json` con fecha UTC, hash de Git, banderas de ejecución y tope financiero ($59.97 USD / 17.1M tokens según saldo calibrado).
   - Inicia el contenedor: `docker compose up -d daemon`.
   - Espera hasta 3 minutos confirmando el primer latido (`heartbeat.json`) y eventos en `eventos.jsonl`.
   > **REGLA CRÍTICA**: A partir de la captura de la línea base y hasta el cierre de la corrida, la llave del reto **no debe utilizarse para ninguna otra actividad**, garantizando una atribución financiera exacta del delta del panel.

2. **Inicio de Telemetría de Recursos (Host Windows)**:
   En una segunda ventana de PowerShell que permanecerá abierta durante la corrida:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\muestrear-docker.ps1
   ```
   *(Registra CPU, RAM, tiempo activo y reinicios en `data/pruebas-reto/carga/recursos.csv` cada 5 minutos).*

### 4.2. Opción B: Ejecución Directa en CLI (Node / tsx)
Si prefiere ejecutarlo directamente en PowerShell sin contenedor:
```powershell
pnpm daemon --fuente=historico --unidades=1050 --horas=12.5 --horas-minimas=12.2 --lote=6 --concurrencia=3 --presupuesto-tokens=17100000
```

---

## 5. Lista de Verificación y Monitoreo Hora a Hora

El daemon procesa el trabajo de forma suave y continua (~84 unidades/hora, un lote de 6 candidatos cada ~4.28 minutos con concurrencia 3).

### 5.1. Monitor Rápido en Un Solo Paso:
En cualquier momento de la corrida de 12 horas, ejecute el monitor interactivo:
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\monitor-carga.ps1
```
*Reporta de forma instantánea:*
1. Estado del contenedor Docker y conteo de reinicios.
2. Antigüedad y estado del latido (`heartbeat.json`), alertando si supera los 3 minutos.
3. Horas transcurridas vs meta planificada (12.5h) y mínimo estricto (12.2h).
4. Unidades acumuladas bajo la definición oficial (`oficialFinAFin`) y contadores secundarios (`completadosAgentes123`).
5. Tasa de éxito porcentual y conteo de fallos.
6. Tokens consumidos vs presupuesto tope (17.1M) y costo equivalente en USD.
7. Las últimas 5 tareas completadas con latencia, tokens y resultado del CSV.
8. Brecha máxima con el gateway en la última hora (verificando que sea < 5 minutos).
9. Incidentes por tipo y los últimos 10 eventos del sistema.

### 5.2. Checklist Específico por Hitos Críticos (Horas 1, 3, 6, 9 y 12):

#### ⏰ Hora 1 (Estabilización Temprana):
- [ ] Ejecutar `.\scripts\monitor-carga.ps1`:
  - **Latido**: OK (< 90 segundos de antigüedad, status `"ejecutando"`).
  - **Unidades esperadas**: ~80 a ~90 unidades oficiales.
  - **Contador `completadosAgentes123`**: > 0 (proporcional al porcentaje histórico de aptos PYME).
  - **Tasa de éxito**: $\ge$ 98% (sin fallos irrecuperables).
  - **Brecha gateway horaria**: < 300 segundos (< 5 min).
  - **Consumo de tokens**: ~600k a 1.2M tokens (< 7% del tope de 17.1M).
- [ ] Inspeccionar registros rápidos: `docker compose logs --tail 30 daemon` (sin errores 429 ni excepciones no controladas).
- [ ] Verificar que `scripts/muestrear-docker.ps1` esté registrando filas en `data/pruebas-reto/carga/recursos.csv`.

#### ⏰ Hora 3 (Ritmo Crucero y Verificación de Memoria):
- [ ] Ejecutar `.\scripts\monitor-carga.ps1`:
  - **Unidades esperadas**: ~250 unidades acumuladas.
  - **Reinicios del contenedor**: 0 (o justificados en incidentes recuperados).
  - **Tokens consumidos**: ~2M a ~3.5M tokens (< 20% del tope).
- [ ] Revisar tabla horaria en `data/pruebas-reto/carga/bitacora-carga.md` (horas 1 y 2 con métricas completas).
- [ ] Validar memoria en `recursos.csv`: consumo estable (< 500 MB RAM, sin fugas de memoria).

#### ⏰ Hora 6 (Medio Término — Control Financiero y Cola):
- [ ] Ejecutar `.\scripts\monitor-carga.ps1`:
  - **Unidades esperadas**: ~500 a 530 unidades acumuladas.
  - **Tasa de éxito**: Mantenerse $\ge$ 98%.
  - **Tokens consumidos**: ~5M a ~7.5M tokens (< 45% del tope).
  - **Gasto proyectado**: Bien por debajo del límite de $59.97 USD (reserva intacta).
- [ ] Validar que la cola de días históricos esté avanzando suavemente hacia la siguiente partición de fechas sin atascos.

#### ⏰ Hora 9 (Tres Cuartos de Corrida):
- [ ] Ejecutar `.\scripts\monitor-carga.ps1`:
  - **Unidades esperadas**: ~750 a ~800 unidades acumuladas.
  - **Latido**: Continúa en verde (< 90s).
  - **Tasa de fallos no recuperados**: 0.
- [ ] Verificar que no existan activaciones anómalas del disyuntor (*circuit breaker*).

#### ⏰ Hora 12 (Ventana Mínima y Preparación para Cierre):
- [ ] Ejecutar `.\scripts\monitor-carga.ps1`:
  - **Duración transcurrida**: $\ge$ 12.0 horas (debe alcanzar $\ge$ 12.2h antes de detenerse).
  - **Unidades acumuladas**: $\ge$ 1.000 a 1.050 unidades oficiales.
  - **Cero duplicados**: Verificar que no existan IDs duplicados.
- [ ] Confirmar que el contenedor permanezca activo hasta cumplir el mínimo estricto de 12.2 horas configurado en `--horas-minimas`.
- [ ] Una vez alcanzadas las 12.5h (o fin automático), proceder con el cierre ordenado mediante `powershell -ExecutionPolicy Bypass -File .\scripts\cerrar-carga.ps1` (Sección 7).

---

## 6. Diagnóstico y Protocolo de Rescate: Heartbeat Estancado o Reinicios

### 6.1. ¿Cómo se detecta una anomalía?
El monitor `.\scripts\monitor-carga.ps1` alertará si ocurre alguna de las siguientes condiciones:
1. **Heartbeat Estancado**: El archivo `heartbeat.json` tiene una antigüedad mayor a **3 minutos** (3 intervalos de ciclo).
2. **Estado de Error**: El campo `status` reporta `"error"` o `"enfriamiento_circuit_breaker"`.
3. **Reinicio de Contenedor**: El contador de reinicios en `docker ps` o `recursos.csv` se incrementa.

### 6.2. Protocolo de Rescate Paso a Paso:
1. **Inspección de Registros**:
   ```powershell
   docker compose logs --tail 50 daemon
   ```
2. **Reinicio Controlado si hay Bloqueo de Red o Socket**:
   ```powershell
   docker compose restart daemon
   ```
3. **Recuperación Automática e Idempotencia**:
   - Al reiniciar, el daemon carga inmediatamente `data/pruebas-reto/carga/estado.json`.
   - Reconstituye la lista `idsExcluidos` con todas las tareas ya finalizadas en la bitácora.
   - Ninguna tarea completada se repite ni duplica (0 duplicados garantizados).
   - Reanuda el procesamiento exactamente en el siguiente lote pendiente de la cola.
   - Registra el evento de reinicio y reanudación en `eventos.jsonl`.
   - Vuelve a emitir latidos regulares (`healthy`).

---

## 7. Detención y Cierre Limpio (*Graceful Shutdown*)

### 7.1. Cierre Automatizado con Conciliación
Al concluir las 12 horas (o cuando el daemon alcance su meta y duración mínima), ejecute el script de cierre:
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\cerrar-carga.ps1
```
*El script realiza automáticamente el procedimiento de cierre:*
1. Verifica si el contenedor sigue activo y ofrece realizar un `docker compose stop daemon` limpio (espera hasta 60s para concluir el lote en vuelo).
2. Solicita interactivamente los números finales del panel del reto (`requests`, `input`, `output`, `cost USD`).
3. Calcula el delta exacto de consumo del reto frente a `panel-lanzamiento.json` y lo persiste en `data/pruebas-reto/carga/panel-cierre.json`.
4. Muestra la tabla de conciliación entre el delta del panel y el libro mayor del agente.
5. Ejecuta en cadena los tres reportes de consolidación:
   - `pnpm bitacora`: Genera la bitácora final en Markdown.
   - `pnpm carga:costo-efectivo --gasto-panel-usd=<delta>`: Prorratea el costo financiero real por tarea en `bitacora-tareas-con-costo.csv`.
   - `pnpm reporte:carga --gasto-panel-usd=<delta>`: Audita los 6 criterios del Reto y genera `data/pruebas-reto/carga/REPORTE-FINAL.md`.
6. Imprime las rutas de los entregables listos para revisión y envío.

### 7.2. Detención del Muestreador de Recursos
En la ventana donde corre `muestrear-docker.ps1`, presione `Ctrl + C` para finalizar el registro de recursos.

---

## 8. Entregables Finales para la Plataforma del Reto

Una vez ejecutado `cerrar-carga.ps1`:

1. **Texto de Resumen para la Plataforma**:
   Copie el contenido generado en [`docs/RESUMEN-S4.md`](RESUMEN-S4.md) y péguelo en el formulario de envío del Reto Agente 2026.
2. **Informe Técnico de Cumplimiento**:
   Consulte [`data/pruebas-reto/carga/REPORTE-FINAL.md`](../data/pruebas-reto/carga/REPORTE-FINAL.md) para confirmar el estado `PASS` en los 6 criterios oficiales.
3. **Bitácora Completa de Tareas**:
   La evidencia auditable de cada tarea reside en `data/pruebas-reto/carga/bitacora-tareas-con-costo.csv` y `bitacora-carga.md`.
