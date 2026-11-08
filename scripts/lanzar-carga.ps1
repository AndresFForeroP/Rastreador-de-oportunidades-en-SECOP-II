# ==============================================================================
# LANZADOR OFICIAL DE LA CORRIDA DE CARGA DE 12 HORAS (S4)
# Script: scripts/lanzar-carga.ps1
#
# Flujo:
# 1. Ejecuta `pnpm preflight` y aborta si el veredicto es NO-GO.
#    (Su llamada al modelo ocurre ANTES de la linea base, fuera de la ventana).
# 2. Confirma y ejecuta `pnpm carga:archivar-ensayos` para arranque limpio.
# 3. Solicita interactivamente la linea base del panel del reto y escribe
#    data/pruebas-reto/carga/panel-lanzamiento.json.
# 4. Escribe data/pruebas-reto/carga/lanzamiento.json con metadatos no secretos.
# 5. Lanza el daemon en Docker Compose: `docker compose up -d daemon`.
# 6. Espera hasta 3 minutos confirmando el primer latido (heartbeat) y eventos.
#
# REGLAS DE SEGURIDAD:
# - NUNCA imprime .env, valores resueltos de entorno ni la llave del reto.
# - NUNCA ejecuta docker compose config ni inspect que vuelquen variables.
# ==============================================================================

[CmdletBinding()]
param(
    [switch]$NoConfirm = $false
)

$ErrorActionPreference = "Continue"

Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host "SECOP II - LANZAMIENTO DE LA CORRIDA DESATENDIDA DE 12 HORAS (S4)" -ForegroundColor Cyan
Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host ""

# ------------------------------------------------------------------------------
# 1. EJECUTAR PRE-FLIGHT (Debe resultar GO)
# ------------------------------------------------------------------------------
Write-Host "[1/6] Ejecutando comprobacion pre-vuelo (pnpm preflight)..." -ForegroundColor Yellow
Write-Host "  (La llamada de prueba al modelo ocurre ANTES de fijar la linea base del panel)" -ForegroundColor DarkGray
Write-Host ""

pnpm preflight
$preflightExitCode = $LASTEXITCODE

if ($preflightExitCode -ne 0) {
    Write-Host ""
    Write-Host "[NO-GO] PRE-FLIGHT RECHAZADO" -ForegroundColor Red
    Write-Host "   El sistema detecto inconsistencias que impiden el lanzamiento seguro." -ForegroundColor Yellow
    Write-Host "Corrija los puntos senalados antes de intentar un nuevo lanzamiento." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "[OK] Pre-flight superado con exito [VEREDICTO: GO]." -ForegroundColor Green
Write-Host ""

# ------------------------------------------------------------------------------
# 2. CONFIRMAR Y ARCHIVAR ENSAYOS PREVIOS
# ------------------------------------------------------------------------------
Write-Host "[2/6] Preparacion de carpeta de evidencias limpias..." -ForegroundColor Yellow
if (-not $NoConfirm) {
    $confirmacionArchivado = Read-Host "¿Desea archivar ensayos previos en data/pruebas-reto/carga/ensayos/? (S/n)"
    if ($confirmacionArchivado -match "^[nN]") {
        Write-Host "Operacion cancelada por el operador." -ForegroundColor Yellow
        exit 0
    }
}

pnpm carga:archivar-ensayos
if ($LASTEXITCODE -ne 0) {
    Write-Host "[!] Error al archivar ensayos previos." -ForegroundColor Red
    exit 1
}
Write-Host "[OK] Directorio de carga limpio y listo para registrar la corrida real." -ForegroundColor Green
Write-Host ""

# ------------------------------------------------------------------------------
# 3. LECTURA INTERACTIVA DE LA LINEA BASE DEL PANEL DEL RETO
# ------------------------------------------------------------------------------
Write-Host "[3/6] Captura de linea base del panel del reto (api.reto.pltk.mx)..." -ForegroundColor Yellow
Write-Host "  Abra el panel de control del reto y consulte los numeros acumulados de la llave grok-4.6." -ForegroundColor White
Write-Host ""

function Leer-NumeroRequerido([string]$mensaje) {
    while ($true) {
        $valor = Read-Host $mensaje
        if ($valor -match "^\s*([0-9]+(\.[0-9]+)?)\s*$") {
            return [double]$Matches[1]
        }
        Write-Host "   Por favor ingrese un numero valido mayor o igual a cero." -ForegroundColor Red
    }
}

$peticionesBase = Leer-NumeroRequerido "  - Total de peticiones (requests) en el panel [ej. 798]"
$inTokensBase   = Leer-NumeroRequerido "  - Tokens de entrada (prompt tokens) en el panel [ej. 1884897]"
$outTokensBase  = Leer-NumeroRequerido "  - Tokens de salida (output tokens) en el panel [ej. 359101]"
$costoUSDBase   = Leer-NumeroRequerido "  - Costo acumulado en USD en el panel [ej. 10.81]"
$saldoBase      = Leer-NumeroRequerido "  - Saldo actual disponible en USD en el panel (obligatorio) [ej. 67.00]"

$horaActualUTC = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
$horaLocalCO   = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss.fffzzz")

$dirCarga = "data/pruebas-reto/carga"
if (-not (Test-Path $dirCarga)) {
    New-Item -ItemType Directory -Path $dirCarga -Force | Out-Null
}

$datosPanelLanzamiento = [ordered]@{
    capturadoEnUTC       = $horaActualUTC
    capturadoEnLocalCO   = $horaLocalCO
    zonaHoraria          = "America/Bogota (-05:00)"
    peticionesAcumuladas = [int64]$peticionesBase
    tokensEntrada        = [int64]$inTokensBase
    tokensSalida         = [int64]$outTokensBase
    tokensTotalSuma      = [int64]($inTokensBase + $outTokensBase)
    costoUSD             = [double]$costoUSDBase
    saldoDisponibleUSD   = $saldoBase
    fuente               = "panel oficial del reto api.reto.pltk.mx"
}

$rutaPanelJson = Join-Path $dirCarga "panel-lanzamiento.json"
$datosPanelLanzamiento | ConvertTo-Json -Depth 5 | Set-Content -Path $rutaPanelJson -Encoding UTF8
Write-Host "[OK] Linea base del panel registrada en: $rutaPanelJson" -ForegroundColor Green
Write-Host ""

# ADVERTENCIA CRITICA DE USO EXCLUSIVO
Write-Host "********************************************************************************" -ForegroundColor Yellow
Write-Host "[!] REGLA CRITICA DE ATRIBUCION FINANCIERA:" -ForegroundColor Yellow
Write-Host "   A partir de este instante y hasta el cierre de la corrida de 12 horas," -ForegroundColor White
Write-Host "   la llave del reto NO DEBE SER USADA para ninguna otra llamada ni aplicacion." -ForegroundColor White
Write-Host "   Cualquier peticion externa distorsionara el delta del panel del reto." -ForegroundColor White
Write-Host "********************************************************************************" -ForegroundColor Yellow
Write-Host ""

# ------------------------------------------------------------------------------
# 4. REGISTRAR METADATOS DE LANZAMIENTO (lanzamiento.json)
# ------------------------------------------------------------------------------
Write-Host "[4/6] Registrando metadatos de configuracion en lanzamiento.json..." -ForegroundColor Yellow

$gitShortHash = (git rev-parse --short HEAD).Trim()

# Leer configuracion de precios no secreta
$configPreciosJson = Get-Content -Raw "config/precios.json" | ConvertFrom-Json
$tarifaGrok = $configPreciosJson.modelos."grok-4.6"
$precioUnitario = [double]$tarifaGrok.porMillonEntrada

# S4-FINAL (C.7): Recomputar el tope maximo permitido segun el saldo obligatorio ingresado
$precioPorTokenUSD = $precioUnitario / 1000000.0
$saldoDisponibleUSD = [Math]::Round(($saldoBase * 0.90), 4)
$topeExacto = [Math]::Floor($saldoDisponibleUSD / $precioPorTokenUSD)
$topeTokensPermitido = [Math]::Floor($topeExacto / 100000) * 100000

# Determinar banderas de ejecucion desde variables de entorno o defaults oficiales
$banderas = [ordered]@{
    fuente              = if ($env:DAEMON_FUENTE) { $env:DAEMON_FUENTE } else { "historico" }
    metaUnidades        = if ($env:DAEMON_UNIDADES) { [int]$env:DAEMON_UNIDADES } else { 1050 }
    horasVentana        = if ($env:DAEMON_HORAS) { [double]$env:DAEMON_HORAS } else { 12.5 }
    horasMinimas        = if ($env:DAEMON_HORAS_MINIMAS) { [double]$env:DAEMON_HORAS_MINIMAS } else { 12.2 }
    lote                = if ($env:DAEMON_LOTE) { [int]$env:DAEMON_LOTE } else { 6 }
    concurrencia        = if ($env:DAEMON_CONCURRENCIA) { [int]$env:DAEMON_CONCURRENCIA } else { 3 }
    presupuestoTokens   = if ($env:DAEMON_PRESUPUESTO_TOKENS) { [int64]$env:DAEMON_PRESUPUESTO_TOKENS } else { $topeTokensPermitido }
    ignorarProyeccion   = if ($env:DAEMON_IGNORAR_PROYECCION -eq "true") { $true } else { $false }
}

$presupuestoTokens = $banderas.presupuestoTokens
$equivUSD = [Math]::Round(($presupuestoTokens * $precioUnitario) / 1000000, 4)

# Validacion estricta de rieles de presupuesto: abortar si supera el tope permitido
if ($presupuestoTokens -gt $topeTokensPermitido) {
    Write-Host ""
    Write-Host "[ABORTADO] EL TOPE DE TOKENS CONFIGURADO SUPERA EL MAXIMO PERMITIDO POR EL SALDO" -ForegroundColor Red
    Write-Host "   • Saldo ingresado:                  $$saldoBase USD" -ForegroundColor Yellow
    Write-Host "   • Saldo disponible (-10% reserva):   $$saldoDisponibleUSD USD" -ForegroundColor Yellow
    Write-Host "   • Tope maximo permitido:            $($topeTokensPermitido.ToString('N0')) tokens" -ForegroundColor Red
    Write-Host "   • Tope actualmente configurado:     $($presupuestoTokens.ToString('N0')) tokens" -ForegroundColor Red
    Write-Host ""
    Write-Host "Ajuste DAEMON_PRESUPUESTO_TOKENS en su archivo .env a un valor <= $($topeTokensPermitido.ToString('N0')) antes de lanzar." -ForegroundColor Yellow
    exit 1
}

Write-Host "[OK] Verificacion de presupuesto superada:" -ForegroundColor Green
Write-Host "   • Saldo panel ingresado:            $$saldoBase USD (Reserva 10%: $$([Math]::Round($saldoBase * 0.10, 2)) USD)" -ForegroundColor White
Write-Host "   • Tope configurado:                 $($presupuestoTokens.ToString('N0')) tokens ($$equivUSD USD)" -ForegroundColor White
Write-Host "   • Tope maximo permitido por saldo:  $($topeTokensPermitido.ToString('N0')) tokens" -ForegroundColor White

$datosLanzamiento = [ordered]@{
    inicioUTC            = $horaActualUTC
    inicioLocalCO        = $horaLocalCO
    gitShortHash         = $gitShortHash
    banderasConfig       = $banderas
    precios = [ordered]@{
        moneda           = $configPreciosJson.moneda
        fuente           = $configPreciosJson.fuente
        actualizado      = $configPreciosJson.actualizado
        porMillonEntrada = $tarifaGrok.porMillonEntrada
        porMillonSalida  = $tarifaGrok.porMillonSalida
    }
    presupuesto = [ordered]@{
        capTokens        = $presupuestoTokens
        equivalenteUSD   = $equivUSD
        definicionUnidad = "oficialFinAFin"
    }
}

$rutaLanzamientoJson = Join-Path $dirCarga "lanzamiento.json"
$datosLanzamiento | ConvertTo-Json -Depth 5 | Set-Content -Path $rutaLanzamientoJson -Encoding UTF8
Write-Host "[OK] Metadatos de lanzamiento guardados en: $rutaLanzamientoJson" -ForegroundColor Green
Write-Host ""

# ------------------------------------------------------------------------------
# 5. INICIAR EL CONTENEDOR EN DOCKER COMPOSE
# ------------------------------------------------------------------------------
Write-Host "[5/6] Iniciando servicio daemon en Docker Compose (docker compose up -d daemon)..." -ForegroundColor Yellow

docker compose up -d daemon
if ($LASTEXITCODE -ne 0) {
    Write-Host "Intentando con docker-compose clasico..." -ForegroundColor DarkGray
    docker-compose up -d daemon
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[!] Fallo el inicio del contenedor Docker." -ForegroundColor Red
        exit 1
    }
}

Write-Host "[OK] Contenedor daemon iniciado en segundo plano." -ForegroundColor Green
Write-Host ""

# ------------------------------------------------------------------------------
# 6. ESPERAR Y CONFIRMAR PRIMER LATIDO (HASTA 3 MINUTOS)
# ------------------------------------------------------------------------------
Write-Host "[6/6] Verificando confirmacion del primer latido (heartbeat.json)..." -ForegroundColor Yellow
Write-Host "  Esperando inicializacion y primer reporte (maximo 180 segundos)..." -ForegroundColor DarkGray

$rutaHeartbeat = Join-Path $dirCarga "heartbeat.json"
$rutaEventos   = Join-Path $dirCarga "eventos.jsonl"
$tiempoMaxSeg  = 180
$inicioEspera  = Get-Date
$confirmado    = $false

while (((Get-Date) - $inicioEspera).TotalSeconds -lt $tiempoMaxSeg) {
    if ((Test-Path $rutaHeartbeat) -and (Test-Path $rutaEventos)) {
        try {
            $hb = Get-Content -Raw $rutaHeartbeat | ConvertFrom-Json
            if ($hb.status -and $hb.status -ne "error") {
                $confirmado = $true
                break
            }
        } catch {
            # El archivo puede estar en escritura atomica
        }
    }
    Start-Sleep -Seconds 3
    Write-Host -NoNewline "."
}
Write-Host ""

if ($confirmado) {
    Write-Host "================================================================================" -ForegroundColor Green
    Write-Host "[OK] DAEMON CONFIRMADO Y OPERANDO CORRECTAMENTE" -ForegroundColor Green
    Write-Host "   - PID Contenedor:    $($hb.pid)" -ForegroundColor White
    Write-Host "   - Estado Heartbeat:  $($hb.status)" -ForegroundColor White
    Write-Host "   - Ciclo Inicial:     $($hb.cycle)" -ForegroundColor White
    Write-Host "   - Meta Unidades:     $($hb.limites.metaUnidades) ($($banderas.metaUnidades))" -ForegroundColor White
    Write-Host "   - Ventana Regulada:  $($banderas.horasVentana)h (Minimo estricto: $($banderas.horasMinimas)h)" -ForegroundColor White
    Write-Host "   - Presupuesto Duro:  $($banderas.presupuestoTokens.ToString('N0')) tokens (~$$equivUSD USD)" -ForegroundColor White
    Write-Host "================================================================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "Siguientes pasos operativos:" -ForegroundColor Cyan
    Write-Host "1. En otra ventana de PowerShell, inicie el muestreo de recursos:" -ForegroundColor White
    Write-Host "   powershell -ExecutionPolicy Bypass -File .\scripts\muestrear-docker.ps1" -ForegroundColor Yellow
    Write-Host "2. Supervise periodicamente con el monitor de un solo paso:" -ForegroundColor White
    Write-Host "   powershell -ExecutionPolicy Bypass -File .\scripts\monitor-carga.ps1" -ForegroundColor Yellow
    Write-Host ""
} else {
    Write-Host "================================================================================" -ForegroundColor Red
    Write-Host "[!] ADVERTENCIA: No se confirmo el latido tras 180 segundos." -ForegroundColor Yellow
    Write-Host "   El contenedor fue lanzado pero aun no ha escrito heartbeat.json." -ForegroundColor Yellow
    Write-Host "   Comprobaciones recomendadas:" -ForegroundColor White
    Write-Host "   - Revise los registros del contenedor:  docker compose logs --tail 50 daemon" -ForegroundColor DarkGray
    Write-Host "   - Verifique el estado del proceso:      docker ps --filter 'name=daemon'" -ForegroundColor DarkGray
    Write-Host "   - Revise permisos en:                  data/pruebas-reto/carga/" -ForegroundColor DarkGray
    Write-Host "================================================================================" -ForegroundColor Red
    exit 1
}
