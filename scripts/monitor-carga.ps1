# ==============================================================================
# MONITOR DE ESTADO EN UN SOLO PASO (ONE-SHOT) - CORRIDA DE CARGA (S4)
# Script: scripts/monitor-carga.ps1
#
# Proporciona una instantanea completa del estado de la corrida desatendida:
# - Estado del contenedor Docker y conteo de reinicios
# - Antiguedad y estado del latido (heartbeat)
# - Tiempo transcurrido vs horas planificadas y minimas
# - Unidades procesadas bajo cada definicion vs meta oficial (1.150)
# - Tasa de exito acumulada (exitos / total)
# - Tokens consumidos vs presupuesto tope (8M) y equivalente USD
# - Ultimas 5 filas de la bitacora CSV por tarea
# - Brecha maxima entre peticiones al gateway en la ultima hora
# - Ultimos 10 eventos y conteo de errores por tipo
#
# REGLAS DE SEGURIDAD:
# - Salida en texto plano, sin secretos ni volcado de variables de entorno.
# ==============================================================================

[CmdletBinding()]
param()

$dirCarga = "data/pruebas-reto/carga"
$rutaHeartbeat = Join-Path $dirCarga "heartbeat.json"
$rutaEstado    = Join-Path $dirCarga "estado.json"
$rutaEventos   = Join-Path $dirCarga "eventos.jsonl"
$rutaCsv       = Join-Path $dirCarga "bitacora-tareas.csv"
$rutaRecursos  = Join-Path $dirCarga "recursos.csv"

Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host "SECOP II - MONITOR DE CORRIDA DESATENDIDA (S4)" -ForegroundColor Cyan
Write-Host "Fecha / Hora Local: $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss')) (UTC-5) | UTC: $((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ssZ'))" -ForegroundColor DarkGray
Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host ""

# ------------------------------------------------------------------------------
# 1. ESTADO DEL CONTENEDOR DOCKER Y REINICIOS
# ------------------------------------------------------------------------------
Write-Host "[1/6] ESTADO DEL CONTENEDOR DOCKER:" -ForegroundColor Yellow
$dockerStatus = $null
$restartCount = 0

try {
    $psOut = (docker ps --all --filter "name=daemon" --format "{{.Status}}") 2>&1
    if ($LASTEXITCODE -eq 0 -and $psOut) {
        $dockerStatus = ($psOut | Out-String).Trim()
        Write-Host "   - Contenedor 'daemon': $dockerStatus" -ForegroundColor White
    } else {
        Write-Host "   - Contenedor 'daemon': NO ENCONTRADO EN EJECUCION" -ForegroundColor Yellow
    }
} catch {
    Write-Host "   - Docker CLI no disponible directamente en esta sesion." -ForegroundColor DarkGray
}

if (Test-Path $rutaRecursos) {
    try {
        $ultimosRecursos = Import-Csv $rutaRecursos | Select-Object -Last 1
        if ($ultimosRecursos -and $ultimosRecursos.reinicios) {
            $restartCount = [int]$ultimosRecursos.reinicios
            Write-Host "   - Reinicios registrados (recursos.csv): $restartCount" -ForegroundColor White
        }
    } catch {}
}

# ------------------------------------------------------------------------------
# 2. LATIDO (HEARTBEAT) Y TIEMPO TRANSCURRIDO
# ------------------------------------------------------------------------------
Write-Host ""
Write-Host "[2/6] TELEMETRIA DE LATIDO (HEARTBEAT):" -ForegroundColor Yellow

if (-not (Test-Path $rutaHeartbeat)) {
    Write-Host "   [!] Archivo heartbeat.json no encontrado en $dirCarga." -ForegroundColor Red
} else {
    try {
        $hb = Get-Content -Raw $rutaHeartbeat | ConvertFrom-Json
        $hbDto = [DateTimeOffset]::Parse($hb.timestamp)
        $ahoraDto = [DateTimeOffset]::UtcNow
        $antiguedadSeg = [Math]::Round(($ahoraDto - $hbDto).TotalSeconds, 1)
        if ($antiguedadSeg -lt 0) { $antiguedadSeg = 0 }

        $colorHb = "Green"
        $alertaHb = "OK"
        if ($antiguedadSeg -gt 180) {
            $colorHb = "Red"
            $alertaHb = "ALERTA: HEARTBEAT ESTANCADO (> 3 minutos)"
        } elseif ($antiguedadSeg -gt 90) {
            $colorHb = "Yellow"
            $alertaHb = "AVISO (> 90 segundos)"
        }

        Write-Host "   - Estado actual:      $($hb.status)" -ForegroundColor White
        Write-Host "   - Ultimo reporte:     $($hb.timestamp) (hace $antiguedadSeg seg) -> [$alertaHb]" -ForegroundColor $colorHb
        Write-Host "   - PID en contenedor:  $($hb.pid)" -ForegroundColor White
        Write-Host "   - Ciclo actual:       $($hb.cycle)" -ForegroundColor White
        Write-Host "   - Fecha procesada:    $($hb.fechaActual)" -ForegroundColor White

        $duracionSeg = if ($hb.duracionTranscurridaSeg) { $hb.duracionTranscurridaSeg } else { 0 }
        $duracionHoras = [Math]::Round($duracionSeg / 3600, 2)
        $metaHoras = if ($hb.limites.horasObjetivo) { $hb.limites.horasObjetivo } else { 12.5 }
        $minHoras = 12.2

        Write-Host "   - Tiempo transcurrido: $duracionHoras h de $metaHoras h planificadas (Minimo obligatorio: $minHoras h)" -ForegroundColor White
    } catch {
        Write-Host "   [!] Error leyendo heartbeat.json: $_" -ForegroundColor Red
    }
}

# ------------------------------------------------------------------------------
# 3. UNIDADES PROCESADAS, TASA DE EXITO Y PRESUPUESTO
# ------------------------------------------------------------------------------
Write-Host ""
Write-Host "[3/6] UNIDADES DE TRABAJO Y PRESUPUESTO:" -ForegroundColor Yellow

if (Test-Path $rutaEstado) {
    try {
        $st = Get-Content -Raw $rutaEstado | ConvertFrom-Json
        $meta = if ($hb -and $hb.limites.metaUnidades) { $hb.limites.metaUnidades } else { 1150 }
        $oficial = $st.contadoresUnidades.oficialFinAFin
        $exitosas = $st.contadoresUnidades.exitosasFinAFin
        $fallidas = $st.contadoresUnidades.fallidasFinAFin
        $pctMeta = [Math]::Round(($oficial / $meta) * 100, 1)

        $tasaExito = if ($oficial -gt 0) { [Math]::Round(($exitosas / $oficial) * 100, 1) } else { 100.0 }

        Write-Host "   - Unidad Oficial S4 (oficialFinAFin): $oficial / $meta ($pctMeta%)" -ForegroundColor Cyan
        Write-Host "     * Exitosas: $exitosas | Fallidas: $fallidas | Tasa de exito: $tasaExito%" -ForegroundColor White
        Write-Host "   - Contadores paralelos:" -ForegroundColor DarkGray
        Write-Host "     * Evaluados Agente 1 (triaje):          $($st.contadoresUnidades.evaluadosAgente1)" -ForegroundColor DarkGray
        Write-Host "     * Clasificados 'Si' por Agente 1:       $($st.contadoresUnidades.clasificadosSi)" -ForegroundColor DarkGray
        Write-Host "     * Completados Agentes 1, 2 y 3:         $($st.contadoresUnidades.completadosAgentes123)" -ForegroundColor DarkGray

        $tokGastados = $st.gastoAcumulado.tokensTotal
        $capTokens = if ($hb -and $hb.limites.presupuestoTokens) { $hb.limites.presupuestoTokens } else { 8000000 }
        $pctTokens = [Math]::Round(($tokGastados / $capTokens) * 100, 1)
        $costoUSD = [Math]::Round(($tokGastados * 3.507) / 1000000, 4)
        $capUSD   = [Math]::Round(($capTokens * 3.507) / 1000000, 2)

        Write-Host "   - Presupuesto Facturado:" -ForegroundColor White
        Write-Host "     * Tokens gastados: $($tokGastados.ToString('N0')) / $($capTokens.ToString('N0')) ($pctTokens%)" -ForegroundColor White
        Write-Host "     * Costo estimado:  $$costoUSD USD / $$capUSD USD (tarifa efectiva: 3.5070 USD/1M)" -ForegroundColor White
    } catch {
        Write-Host "   [!] Error leyendo estado.json: $_" -ForegroundColor Red
    }
}

# ------------------------------------------------------------------------------
# 4. BRECHA MAXIMA DE PETICIONES AL GATEWAY (ULTIMA HORA)
# ------------------------------------------------------------------------------
Write-Host ""
Write-Host "[4/6] RITMO Y BRECHA MAXIMA CON EL GATEWAY:" -ForegroundColor Yellow
$reportoBrecha = $false
if (Test-Path $rutaEventos) {
    try {
        $lineasEventos = Get-Content $rutaEventos
        $brechas = @()
        foreach ($l in $lineasEventos) {
            if ($l -match "brecha_maxima_gateway_horaria") {
                $evt = $l | ConvertFrom-Json
                $brechas += $evt
            }
        }
        if ($brechas.Count -gt 0) {
            $ultimaBrecha = $brechas[-1]
            $segMax = $ultimaBrecha.details.brechaMaximaSeg
            if (-not $segMax) { $segMax = $ultimaBrecha.detalles.brechaMaximaSeg }
            $horaReg = if ($ultimaBrecha.details.hora) { $ultimaBrecha.details.hora } else { $ultimaBrecha.detalles.hora }

            $alertaBrecha = if ($segMax -le 300) { "CUMPLE (< 5 min)" } else { "EXCEDE 5 min" }
            $colorBrecha  = if ($segMax -le 300) { "Green" } else { "Yellow" }
            Write-Host "   - Ultima brecha horaria registrada (Hora $horaReg): $segMax seg -> [$alertaBrecha]" -ForegroundColor $colorBrecha
            $reportoBrecha = $true
        }
    } catch {}
}

# Calculo en ventana rodante de los ultimos 60 minutos desde logs/tokens.jsonl
$rutaTokens = "logs/tokens.jsonl"
if (Test-Path $rutaTokens) {
    try {
        $ahoraUTC = [DateTimeOffset]::UtcNow
        $limite1h = $ahoraUTC.AddHours(-1)
        $timestamps = @()
        Get-Content $rutaTokens | ForEach-Object {
            try {
                $tok = $_ | ConvertFrom-Json
                $f = if ($tok.fecha) { $tok.fecha } else { $tok.timestamp }
                if ($f) {
                    $dto = [DateTimeOffset]::Parse($f)
                    if ($dto -ge $limite1h) {
                        $timestamps += $dto
                    }
                }
            } catch {}
        }
        if ($timestamps.Count -ge 2) {
            $brechaEnVivoMax = 0
            for ($i = 1; $i -lt $timestamps.Count; $i++) {
                $diff = ($timestamps[$i] - $timestamps[$i-1]).TotalSeconds
                if ($diff -gt $brechaEnVivoMax) { $brechaEnVivoMax = [Math]::Round($diff, 1) }
            }
            $colorEnVivo = if ($brechaEnVivoMax -le 300) { "Green" } else { "Yellow" }
            $alertaEnVivo = if ($brechaEnVivoMax -le 300) { "CUMPLE (< 5 min)" } else { "EXCEDE 5 min" }
            Write-Host "   - Brecha maxima en ventana rodante (ultimos 60 min): $brechaEnVivoMax seg -> [$alertaEnVivo]" -ForegroundColor $colorEnVivo
            $reportoBrecha = $true
        }
    } catch {}
}

if (-not $reportoBrecha) {
    Write-Host "   - Aun no se ha completado la primera ventana de peticiones para consolidar brecha." -ForegroundColor DarkGray
}

# ------------------------------------------------------------------------------
# 5. ULTIMAS 5 FILAS DE LA BITACORA CSV POR TAREA
# ------------------------------------------------------------------------------
Write-Host ""
Write-Host "[5/6] ULTIMAS 5 TAREAS FINALIZADAS (bitacora-tareas.csv):" -ForegroundColor Yellow

if (Test-Path $rutaCsv) {
    try {
        $tareasCsv = Import-Csv $rutaCsv
        $totalTareas = $tareasCsv.Count
        Write-Host "   Total tareas registradas en CSV: $totalTareas" -ForegroundColor DarkGray

        $ultimas5 = $tareasCsv | Select-Object -Last 5
        $tabla = $ultimas5 | Select-Object `
            @{Name="ProcesoId"; Expression={$_.idProceso}}, `
            @{Name="Exito"; Expression={$_.exito}}, `
            @{Name="TokensTotal"; Expression={$_.tokensTotal}}, `
            @{Name="CostoUSD"; Expression={$_.costoDirectoUSD}}, `
            @{Name="Latencia(s)"; Expression={$_.latenciaSeg}}, `
            @{Name="Resultado"; Expression={
                if ($_.resultado.Length -gt 45) { $_.resultado.Substring(0, 42) + "..." } else { $_.resultado }
            }}

        $tabla | Format-Table -AutoSize | Out-String | ForEach-Object { Write-Host $_ -ForegroundColor White }
    } catch {
        Write-Host "   [!] Error leyendo bitacora-tareas.csv: $_" -ForegroundColor Red
    }
} else {
    Write-Host "   (Aun no se ha generado bitacora-tareas.csv)" -ForegroundColor DarkGray
}

# ------------------------------------------------------------------------------
# 6. RESUMEN DE ERRORES POR TIPO Y ULTIMOS 10 EVENTOS
# ------------------------------------------------------------------------------
Write-Host "[6/6] RESUMEN DE INCIDENTES / ERRORES POR TIPO:" -ForegroundColor Yellow

$conteoErrores = @{}
if (Test-Path $rutaCsv) {
    try {
        $csvErrores = Import-Csv $rutaCsv | Where-Object { $_.exito -eq "false" -or $_.errorTipo }
        foreach ($f in $csvErrores) {
            $tipo = if ($f.errorTipo) { $f.errorTipo } else { "desconocido" }
            if ($conteoErrores.ContainsKey($tipo)) {
                $conteoErrores[$tipo] = $conteoErrores[$tipo] + 1
            } else {
                $conteoErrores[$tipo] = 1
            }
        }
    } catch {}
}

if ($conteoErrores.Keys.Count -eq 0) {
    Write-Host "   [OK] Cero errores registrados en las tareas procesadas (100% de exito)." -ForegroundColor Green
} else {
    foreach ($k in $conteoErrores.Keys) {
        $cant = $conteoErrores[$k]
        Write-Host "   - Tipo $k : $cant ocurrencia(s)" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "ULTIMOS 10 EVENTOS DEL SISTEMA (eventos.jsonl):" -ForegroundColor Yellow
if (Test-Path $rutaEventos) {
    try {
        $eventosRaw = Get-Content $rutaEventos | Select-Object -Last 10
        foreach ($eLine in $eventosRaw) {
            $eObj = $eLine | ConvertFrom-Json
            $tipoEvt = if ($eObj.type) { $eObj.type } else { $eObj.tipo }
            $tsEvt   = $eObj.timestamp
            Write-Host "   [$tsEvt] $tipoEvt" -ForegroundColor White
        }
    } catch {
        Write-Host "   [!] Error leyendo eventos.jsonl: $_" -ForegroundColor Red
    }
} else {
    Write-Host "   (Aun no se ha generado eventos.jsonl)" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "================================================================================" -ForegroundColor Cyan
