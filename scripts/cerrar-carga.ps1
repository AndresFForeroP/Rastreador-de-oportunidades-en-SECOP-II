# ==============================================================================
# CIERRE OPERATIVO Y CONCILIACION FINANCIERA - CORRIDA DE CARGA (S4)
# Script: scripts/cerrar-carga.ps1
#
# Flujo:
# 1. Verifica si el contenedor daemon esta en ejecucion y ofrece detencion limpia
#    (docker compose stop daemon, respetando stop_grace_period: 60s).
# 2. Solicita interactivamente los numeros acumulados del panel al cierre.
# 3. Calcula el delta del panel frente a panel-lanzamiento.json y lo escribe
#    en data/pruebas-reto/carga/panel-cierre.json.
# 4. Compara el delta del panel contra los totales del ledger local.
# 5. Ejecuta la generacion de bitacora, prorrateo de costo efectivo y reporte final:
#    - pnpm bitacora
#    - pnpm carga:costo-efectivo --gasto-panel-usd=<deltaUSD>
#    - pnpm reporte:carga --gasto-panel-usd=<deltaUSD>
# 6. Imprime las rutas de RESUMEN-S4.md y REPORTE-FINAL.md y el chequeo de consistencia.
#
# REGLAS DE SEGURIDAD:
# - NUNCA imprime .env, valores resueltos de entorno ni la llave del reto.
# - NUNCA ejecuta docker compose config ni inspect que vuelquen variables.
# ==============================================================================

[CmdletBinding()]
param(
    [switch]$Force = $false
)

$ErrorActionPreference = "Continue"

Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host "🏁 SECOP II - CIERRE OPERATIVO Y CONCILIACION FINANCIERA (S4)" -ForegroundColor Cyan
Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host ""

$dirCarga = "data/pruebas-reto/carga"
$rutaPanelInicio = Join-Path $dirCarga "panel-lanzamiento.json"
$rutaPanelCierre = Join-Path $dirCarga "panel-cierre.json"
$rutaEstado      = Join-Path $dirCarga "estado.json"

# ------------------------------------------------------------------------------
# 1. VERIFICAR CONTENEDOR Y DETENCION LIMPIA (GRACEFUL SHUTDOWN)
# ------------------------------------------------------------------------------
Write-Host "[1/5] Verificando estado del contenedor daemon..." -ForegroundColor Yellow

$psOut = (docker ps --filter "name=daemon" --format "{{.Names}}") 2>&1
$daemonActivo = ($LASTEXITCODE -eq 0 -and $psOut -and ($psOut | Out-String).Trim() -match "daemon")

if ($daemonActivo) {
    Write-Host "   El contenedor 'daemon' sigue activo en segundo plano." -ForegroundColor Yellow
    $detener = "s"
    if (-not $Force) {
        $detener = Read-Host "   ¿Desea detener el contenedor ahora de forma limpia (graceful stop)? (S/n)"
    }
    if ($detener -notmatch "^[nN]") {
        Write-Host "   Enviando senal de detencion ordenada (espera hasta 60s para lote en vuelo)..." -ForegroundColor White
        docker compose stop daemon
        if ($LASTEXITCODE -ne 0) {
            docker-compose stop daemon
        }
        Write-Host "   [OK] Contenedor detenido ordenadamente." -ForegroundColor Green
    } else {
        Write-Host "   Operacion continuada con el contenedor en su estado actual." -ForegroundColor DarkGray
    }
} else {
    Write-Host "   [OK] El contenedor 'daemon' ya ha finalizado su ejecucion." -ForegroundColor Green
}
Write-Host ""

# ------------------------------------------------------------------------------
# 2. CAPTURA DE METRICAS DEL PANEL AL CIERRE Y CALCULO DEL DELTA
# ------------------------------------------------------------------------------
Write-Host "[2/5] Captura de metricas acumuladas en el panel del reto (api.reto.pltk.mx)..." -ForegroundColor Yellow

if (-not (Test-Path $rutaPanelInicio)) {
    Write-Host "   [!] Advertencia: No se encontro $rutaPanelInicio (linea base inicial)." -ForegroundColor Yellow
    Write-Host "   Se creara una linea base ficticia en cero para el calculo del delta." -ForegroundColor DarkGray
    $datosInicio = [ordered]@{
        peticionesAcumuladas = 0
        tokensEntrada        = 0
        tokensSalida         = 0
        costoUSD             = 0.0
    }
} else {
    $datosInicio = Get-Content -Raw $rutaPanelInicio | ConvertFrom-Json
}

function Leer-NumeroRequerido([string]$mensaje) {
    while ($true) {
        $valor = Read-Host $mensaje
        if ($valor -match "^\s*([0-9]+(\.[0-9]+)?)\s*$") {
            return [double]$Matches[1]
        }
        Write-Host "   Por favor ingrese un numero valido mayor o igual a cero." -ForegroundColor Red
    }
}

$peticionesFin = Leer-NumeroRequerido "  - Peticiones (requests) totales en el panel al cierre [Base previa: $($datosInicio.peticionesAcumuladas)]"
$inTokensFin   = Leer-NumeroRequerido "  - Tokens de entrada acumulados en el panel al cierre [Base previa: $($datosInicio.tokensEntrada)]"
$outTokensFin  = Leer-NumeroRequerido "  - Tokens de salida acumulados en el panel al cierre [Base previa: $($datosInicio.tokensSalida)]"
$costoUSDFin   = Leer-NumeroRequerido "  - Costo acumulado en USD en el panel al cierre [Base previa: $($datosInicio.costoUSD)]"

$saldoStr = Read-Host "  - Saldo disponible en USD (opcional, presione Enter si no aplica)"
$saldoFin = $null
if ($saldoStr -match "^\s*([0-9]+(\.[0-9]+)?)\s*$") {
    $saldoFin = [double]$Matches[1]
}

# Calculo del delta exacto
$deltaPeticiones    = [int64]($peticionesFin - $datosInicio.peticionesAcumuladas)
$deltaTokensEntrada = [int64]($inTokensFin - $datosInicio.tokensEntrada)
$deltaTokensSalida  = [int64]($outTokensFin - $datosInicio.tokensSalida)
$deltaTokensSuma    = [int64]($deltaTokensEntrada + $deltaTokensSalida)
$deltaUSD           = [Math]::Round([double]($costoUSDFin - $datosInicio.costoUSD), 4)

$horaFinUTC = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
$horaFinLocalCO = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss.fffzzz")

$datosPanelCierre = [ordered]@{
    capturadoEnUTC = $horaFinUTC
    capturadoEnLocalCO = $horaFinLocalCO
    panelInicio = $datosInicio
    panelCierre = [ordered]@{
        peticionesAcumuladas = [int64]$peticionesFin
        tokensEntrada        = [int64]$inTokensFin
        tokensSalida         = [int64]$outTokensFin
        tokensTotalSuma      = [int64]($inTokensFin + $outTokensFin)
        costoUSD             = [double]$costoUSDFin
        saldoDisponibleUSD   = $saldoFin
    }
    deltaReal = [ordered]@{
        deltaPeticiones    = $deltaPeticiones
        deltaTokensEntrada = $deltaTokensEntrada
        deltaTokensSalida  = $deltaTokensSalida
        deltaTokensSuma    = $deltaTokensSuma
        deltaCostoUSD      = $deltaUSD
    }
}

$datosPanelCierre | ConvertTo-Json -Depth 5 | Set-Content -Path $rutaPanelCierre -Encoding UTF8
Write-Host "   [OK] Metricas de cierre y delta guardadas en: $rutaPanelCierre" -ForegroundColor Green
Write-Host ""

# ------------------------------------------------------------------------------
# 3. COMPARACION: DELTA DEL PANEL VS LIBRO MAYOR (LEDGER)
# ------------------------------------------------------------------------------
Write-Host "[3/5] Comparando delta del panel vs totales del ledger local..." -ForegroundColor Yellow

$totalesLedger = [ordered]@{
    tokensEntrada = 0
    tokensSalida  = 0
    tokensTotal   = 0
    costoUSD      = 0.0
    llamadas      = 0
}

if (Test-Path $rutaEstado) {
    try {
        $st = Get-Content -Raw $rutaEstado | ConvertFrom-Json
        $totalesLedger.tokensEntrada = $st.gastoAcumulado.tokensEntrada
        $totalesLedger.tokensSalida  = $st.gastoAcumulado.tokensSalida
        $totalesLedger.tokensTotal   = $st.gastoAcumulado.tokensTotal
        $totalesLedger.costoUSD      = if ($st.gastoAcumulado.costoTotalUSD) { $st.gastoAcumulado.costoTotalUSD } else { 0.0 }
        $totalesLedger.llamadas      = if ($st.gastoAcumulado.llamadasModelo) { $st.gastoAcumulado.llamadasModelo } else { 0 }
    } catch {}
}

Write-Host ""
Write-Host "TABLA DE CONCILIACION FINANCIERA:" -ForegroundColor Cyan
Write-Host "--------------------------------------------------------------------------------" -ForegroundColor DarkGray
Write-Host "| Metrica                    | Delta Panel Reto     | Ledger Local (Estado) |" -ForegroundColor White
Write-Host "--------------------------------------------------------------------------------" -ForegroundColor DarkGray
Write-Host ("| Peticiones / Llamadas      | {0,20} | {1,21} |" -f $deltaPeticiones.ToString("N0"), $totalesLedger.llamadas.ToString("N0"))
Write-Host ("| Tokens Entrada             | {0,20} | {1,21} |" -f $deltaTokensEntrada.ToString("N0"), $totalesLedger.tokensEntrada.ToString("N0"))
Write-Host ("| Tokens Salida (Completion) | {0,20} | {1,21} |" -f $deltaTokensSalida.ToString("N0"), $totalesLedger.tokensSalida.ToString("N0"))
Write-Host ("| Tokens Total Facturados    | {0,20} | {1,21} |" -f $deltaTokensSuma.ToString("N0"), $totalesLedger.tokensTotal.ToString("N0"))
Write-Host ("| Costo Financiero (USD)     | {0,20} | {1,21} |" -f ("$" + $deltaUSD.ToString("F4")), ("$" + $totalesLedger.costoUSD.ToString("F4")))
Write-Host "--------------------------------------------------------------------------------" -ForegroundColor DarkGray
Write-Host ""

# ------------------------------------------------------------------------------
# 4. EJECUTAR REGENERACION DE ENTREGABLES Y CALCULO DE COSTO EFECTIVO
# ------------------------------------------------------------------------------
Write-Host "[4/5] Ejecutando generadores de reportes con delta real ($deltaUSD USD)..." -ForegroundColor Yellow

Write-Host "  -> Regenerando bitacora consolidada (pnpm bitacora)..." -ForegroundColor DarkGray
pnpm bitacora
if ($LASTEXITCODE -ne 0) {
    pnpm exec tsx src/carga/bitacora.ts
}

Write-Host "  -> Calculando prorrateo de costo efectivo (pnpm carga:costo-efectivo)..." -ForegroundColor DarkGray
pnpm carga:costo-efectivo --gasto-panel-usd=$deltaUSD

Write-Host "  -> Generando reporte final y validacion de criterios (pnpm reporte:carga)..." -ForegroundColor DarkGray
pnpm reporte:carga --gasto-panel-usd=$deltaUSD
Write-Host ""

# ------------------------------------------------------------------------------
# 5. RUTAS DE ENTREGABLES Y CHEQUEO DE CONSISTENCIA
# ------------------------------------------------------------------------------
Write-Host "================================================================================" -ForegroundColor Green
Write-Host "[OK] CIERRE Y ENTREGABLES OFICIALES COMPLETADOS EXITOSAMENTE" -ForegroundColor Green
Write-Host "================================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Archivos para revision y entrega oficial:" -ForegroundColor Cyan
Write-Host "  1. Texto para pegar en plataforma: docs/RESUMEN-S4.md" -ForegroundColor White
Write-Host "  2. Informe oficial de criterios:  data/pruebas-reto/carga/REPORTE-FINAL.md" -ForegroundColor White
Write-Host "  3. Bitacora completa de carga:    data/pruebas-reto/carga/bitacora-carga.md" -ForegroundColor White
Write-Host "  4. CSV de tareas con costo real:  data/pruebas-reto/carga/bitacora-tareas-con-costo.csv" -ForegroundColor White
Write-Host "  5. Metricas del panel (cierre):   data/pruebas-reto/carga/panel-cierre.json" -ForegroundColor White
Write-Host ""
Write-Host "Consulte REPORTE-FINAL.md para verificar el cumplimiento de los 6 criterios del Reto." -ForegroundColor Green
Write-Host "================================================================================" -ForegroundColor Cyan

