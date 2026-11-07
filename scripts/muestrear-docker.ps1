param(
    [string]$Contenedor = "",
    [int]$IntervaloSegundos = 300,
    [string]$RutaSalida = "data/pruebas-reto/carga/recursos.csv",
    [int]$MaxMuestras = 0
)

# Auto-detectar contenedor del daemon si no se especifico
if (-not $Contenedor) {
    $candidatos = docker ps --filter "name=daemon" --format "{{.Names}}"
    if ($candidatos) {
        $Contenedor = ($candidatos -split "`r?`n")[0].Trim()
    } else {
        $Contenedor = "rastreador-secop-ii-daemon-1"
    }
}

Write-Host "================================================================================"
Write-Host "MUESTREADOR DE RECURSOS DOCKER (S4-4)"
Write-Host "  Contenedor objetivo: $Contenedor"
Write-Host "  Intervalo:           $IntervaloSegundos s"
Write-Host "  Destino CSV:         $RutaSalida"
Write-Host "================================================================================"

$dirDestino = Split-Path -Parent $RutaSalida
if ($dirDestino -and -not (Test-Path $dirDestino)) {
    New-Item -ItemType Directory -Path $dirDestino -Force | Out-Null
}

$encabezado = "timestamp,contenedor,cpuPorcentaje,memoriaUso,memoriaLimite,memoriaPorcentaje,uptime,reinicioConteo"
if (-not (Test-Path $RutaSalida) -or (Get-Item $RutaSalida).Length -eq 0) {
    Set-Content -Path $RutaSalida -Value $encabezado -Encoding utf8
}

$muestra = 0

try {
    while ($true) {
        $muestra++
        $ts = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        $estado = docker ps --filter "name=$Contenedor" --format "{{.Status}}"

        if (-not $estado) {
            Write-Warning "[$ts] Contenedor '$Contenedor' no esta en ejecucion."
            $linea = "$ts,$Contenedor,0.00%,0B,0B,0.00%,Detenido,n/d"
            Add-Content -Path $RutaSalida -Value $linea -Encoding utf8
        } else {
            $formatString = '{{.CPUPerc}};{{.MemUsage}};{{.MemPerc}}'
            $statsRaw = docker stats --no-stream --format $formatString $Contenedor 2>$null

            if ($statsRaw) {
                $p = $statsRaw.Trim() -split ";"
                $cpuPerc = if ($p.Length -gt 0) { $p[0].Trim() } else { "0.00%" }
                $memUsageRaw = if ($p.Length -gt 1) { $p[1].Trim() } else { "0B / 0B" }
                $memPerc = if ($p.Length -gt 2) { $p[2].Trim() } else { "0.00%" }

                $pMem = $memUsageRaw -split " / "
                $memUso = if ($pMem.Length -gt 0) { $pMem[0].Trim() } else { $memUsageRaw }
                $memLimite = if ($pMem.Length -gt 1) { $pMem[1].Trim() } else { "n/d" }

                $uptime = docker ps --filter "name=$Contenedor" --format "{{.RunningFor}}" 2>$null
                if (-not $uptime) { $uptime = $estado }

                $reinicioConteo = docker inspect --format '{{.RestartCount}}' $Contenedor 2>$null
                if (-not $reinicioConteo) { $reinicioConteo = "0" }

                $uptimeCsv = '"' + ($uptime.Trim() -replace '"', '""') + '"'
                $linea = "$ts,$Contenedor,$cpuPerc,$memUso,$memLimite,$memPerc,$uptimeCsv,$($reinicioConteo.Trim())"
                Add-Content -Path $RutaSalida -Value $linea -Encoding utf8

                Write-Host "[$ts] Muestra #$muestra | CPU: $cpuPerc | Mem: $memUso / $memLimite ($memPerc) | Uptime: $uptime | Reinicios: $reinicioConteo"
            }
        }

        if ($MaxMuestras -gt 0 -and $muestra -ge $MaxMuestras) {
            Write-Host "Alcanzado limite de $MaxMuestras muestras."
            break
        }

        Start-Sleep -Seconds $IntervaloSegundos
    }
} finally {
    Write-Host "Muestreo finalizado. Muestras registradas: $muestra"
}
