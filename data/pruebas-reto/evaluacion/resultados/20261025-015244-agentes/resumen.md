# Resumen de Evaluación de Invariantes: Agente 2 y Agente 3 (S3-5)

> **Ejecución**: `20261024-205244_ae97` | **Fecha**: `2026-10-25T01:52:44.322Z`
> **Muestra**: 10 casos reales | **Semilla determinista**: `42`
> **Costo estimado**: **$ 0.3640 USD** (202.123 tokens facturados)

## 1. Invariantes del Agente 2 ("resumidor")

| Invariante | Descripción | Total | Pasan | Tasa Éxito | Estado |
|---|---|:---:|:---:|:---:|:---:|
| **Ficha vs Dataset** | Campos numéricos y fechas iguales al dataset (`valorCOP`, `deadline`, `duracion`, `lotes`, `entidad`) | 10 | 10 | **100.0%** | ✅ PASS |
| **Cifras de 6+ Dígitos** | Cifras en texto del modelo existen en ficha o descripción | 10 | 10 | **100.0%** | ✅ PASS |
| **Claves de basadoEn** | Todo `basadoEn` es una clave real de `FichaProceso` | 10 | 10 | **100.0%** | ✅ PASS |
| **Verificaciones en Pliego** | El arreglo `verificarEnElPliego` nunca está vacío | 10 | 10 | **100.0%** | ✅ PASS |
| **No Afirma Leer Pliego** | El resumen jamás declara haber leído el pliego de condiciones | 10 | 10 | **100.0%** | ✅ PASS |

### Casos Señalados para Revisión Humana (Patrones de Requisitos Habilitantes)
> Regla S3-5: La detección de patrones de requisitos habilitantes en frases no constituye falla automática, sino que se remite a revisión humana.

| Caso # | Proceso ID | Evidencia Detectada |
|:---:|---|---|
| 35 | `CO1.REQ.11155472` | Señalado para revisión humana (1 coincidencias): [capital_de_trabajo] "El presupuesto es alto para muchas pymes: exige capacidad de suministro, capital de trabajo y posiblemente inventario inmediato." |

## 2. Invariantes del Agente 3 ("documentos")

| Invariante | Descripción | Total | Pasan | Tasa Éxito | Estado |
|---|---|:---:|:---:|:---:|:---:|
| **Origen de Ítems** | Provienen únicamente del catálogo o de anexos reales indexados | 10 | 10 | **100.0%** | ✅ PASS |
| **Sin Duplicados** | No existen ítems duplicados por nombre ni por ID de catálogo | 10 | 1 | **10.0%** | ❌ FAIL |
| **Nada Obligatorio sin Negación** | Ningún requisito marcado obligatorio salvo dentro de negación explícita | 10 | 9 | **90.0%** | ❌ FAIL |
| **Aviso Fijo Orientativo** | Presencia obligatoria del aviso oficial `"Lista orientativa: confirme siempre en el pliego oficial"` | 10 | 10 | **100.0%** | ✅ PASS |
| **Respaldo Legal No Null** | `respaldoLegal` solo se muestra si no es null (jamás imprime null) | 10 | 10 | **100.0%** | ✅ PASS |
| **Sin Anexos: Frase Exacta** | Si no hay anexos, dice *"sin anexos indexados aún"* y jamás niega existencia | 10 | 10 | **100.0%** | ✅ PASS |

### Prueba Forzando el Agente (--siempre-agente, 3 casos)
| Invariante | Total | Pasan | Tasa Éxito | Estado |
|---|:---:|:---:|:---:|:---:|
| **Origen de Ítems (con LLM)** | 3 | 3 | **100.0%** | ✅ PASS |
| **Sin Duplicados (con LLM)** | 3 | 0 | **0.0%** | ❌ FAIL |
| **Nada Obligatorio sin Negación (con LLM)** | 3 | 3 | **100.0%** | ✅ PASS |

## 3. Detalle de Fallos e Inconsistencias Registradas

| Agente | Invariante | Proceso ID | Evidencia del Fallo |
|---|---|---|---|
| Agente 3 | Sin duplicados | `CO1.REQ.11171503` | Nombre duplicado: "ACTA DE EVALUACION DEFINITIVA MC 045 2026 RENDICION DE CUENTAS"; Nombre duplicado: "ESTUDIO Y DOCUMENTO PREVIO MC 045 2026 RENDICION DE CUENTAS"; Nombre duplicado: "CDP MC 041 2026 RENDICION DE CUENTAS"; Nombre duplicado: "CDP MC 041 2026 RENDICION DE CUENTAS"; Nombre duplicado: "BPIN MC 041 2026 RENDICION DE CUENTAS"; Nombre duplicado: "ACTA DE EVALUACION PRELIMINAR N°02 PROCESO MC 045 2026"; Nombre duplicado: "BPIN MC 041 2026 RENDICION DE CUENTAS"; Nombre duplicado: "ACTA DE EVALUACION PRELIMINAR PROCESO MC 045 2026"; Nombre duplicado: "ESTUDIO Y DOCUMENTO PREVIO MC 045 2026 RENDICION DE CUENTAS"; Nombre duplicado: "1 ACEPTACION DE LA OFERTA CPS 268 2026 HERNANDEZ PYD SOLUCIONES"; Nombre duplicado: "1 ACEPTACION DE LA OFERTA CPS 268 2026 HERNANDEZ PYD SOLUCIONES" |
| Agente 3 | Sin duplicados | `CO1.REQ.11166802` | Nombre duplicado: "4. AIU DESGLOSE"; Nombre duplicado: "3. ANALISIS DEL SECTOR PH 2026"; Nombre duplicado: "6. CCE EICP GI 02 Documento Base V3 30 07 2024 SAMC 00 MT 2026 V.2"; Nombre duplicado: "6. CCE EICP GI 02 Documento Base V3 30 07 2024 SAMC 00 MT 2026 V.2"; Nombre duplicado: "1.4. PAA PLACA HUELLA 2026" |
| Agente 3 | Sin duplicados | `CO1.REQ.11189547` | Nombre duplicado: "16. Matriz 2 Indicadores Financieros y Organizacionales CCE EICP FM 98 Consultoria"; Nombre duplicado: "11. Formato 11 Factores de desempate CCE EICP FM 102 Consultoria"; Nombre duplicado: "10. Formato 10 Factor de sostenibilidad CCE EICP FM 101"; Nombre duplicado: "06. Formato 6 Vinculacion de personas con discapacidad CCE EICP FM 92"; Nombre duplicado: "CRONOGRAMA PROYECTO CME 003 2026"; Nombre duplicado: "VIABILIDAD CME 003 2026"; Nombre duplicado: "15. Matriz 1 Experiencia Cultura, recreacion y deporte"; Nombre duplicado: "12. Formato 12 Autorizacion para el tratamiento de datos personales CCE EICP FM 103 Consultoria"; Nombre duplicado: "03. Formato 3 Experiencia CCE EICP FM 89 Consultoria de estudios" |
| Agente 3 | Sin duplicados | `CO1.REQ.11158747` | Nombre duplicado: "ESTUDIO PREVIO PAÑALES"; Nombre duplicado: "PLIEGO BORRADOR PAÑALES"; Nombre duplicado: "REQUERIMIENTO PAÑALES20261005"; Nombre duplicado: "AVISO DE CONVOCATORIA PAÑALES" |
| Agente 3 | Sin duplicados | `CO1.REQ.11159170` | Nombre duplicado: "2. AVISO DE CONVOCATORIA"; Nombre duplicado: "RESOLUCION DE APERTURA"; Nombre duplicado: "1. CDP"; Nombre duplicado: "4. PROYECTO PLIEGO DE CONDICIONES 2 (F)"; Nombre duplicado: "9. ANALISIS DE PRECIOS"; Nombre duplicado: "8. ANEXO COTIZACIONES ESTUDIOS DEL SECTOR"; Nombre duplicado: "1. CDP"; Nombre duplicado: "0. REQUERIMIENTO"; Nombre duplicado: "7. ESTUDIO DEL SECTOR BIENESTAR 2"; Nombre duplicado: "3. ESTUDIOS PREVIOS"; Nombre duplicado: "3. ESTUDIOS PREVIOS"; Nombre duplicado: "PLIEGO DE CONDICIONES"; Nombre duplicado: "8. ANEXO COTIZACIONES ESTUDIOS DEL SECTOR"; Nombre duplicado: "2. AVISO DE CONVOCATORIA"; Nombre duplicado: "7. ESTUDIO DEL SECTOR BIENESTAR 2"; Nombre duplicado: "ANEXO 1 FORMATOS"; Nombre duplicado: "6. ANEXO MATRIZ DE RIESGOS"; Nombre duplicado: "9. ANALISIS DE PRECIOS" |
| Agente 3 | Sin duplicados | `CO1.REQ.11155472` | Nombre duplicado: "5. ANEXO PROYECTO PLIEGO"; Nombre duplicado: "RESOLUCION DE APERTURA No. 76 08626"; Nombre duplicado: "3. CERTIFICADO PAA 106"; Nombre duplicado: "5. ANEXO PROYECTO PLIEGO"; Nombre duplicado: "6. AVISO DE CONVOCATORIA"; Nombre duplicado: "ESTUDIO PREVIO DEFINITIVO"; Nombre duplicado: "1.1. ANEXO ANALISIS DEL SECTOR"; Nombre duplicado: "4. ANEXO EP MATRIZ DE RIESGOS SAMC005"; Nombre duplicado: "ANEXOS PROVEEDOR" |
| Agente 3 | Sin duplicados | `CO1.REQ.11190680` | Nombre duplicado: "4.ESTUDIO DEL SECTOR CONDOR REV"; Nombre duplicado: "CDP MIRADOR TURISTICO"; Nombre duplicado: "5.ESTUDIOS PREVIOS REV"; Nombre duplicado: "6.PRE PLIEGOS DE CONDICIONES rev"; Nombre duplicado: "2.AVISO DE CONVOCATORIA SAMC SILOS 03 2026"; Nombre duplicado: "banco de proyectos" |
| Agente 3 | Sin duplicados | `CO1.REQ.11176401` | Nombre duplicado: "17.OFERTA ECONOMICA INTER REVERDECIMIENTO PROVENZA"; Nombre duplicado: "15.FORMULARIO 1 PPTO OFICIAL INTER REVERDECIMIENTO PROVENZA"; Nombre duplicado: "7.CERTIFICADO BANCO DE PROYECTOS"; Nombre duplicado: "21. MATRIZ 4 LINEAMIENTOS DE PERSONAL"; Nombre duplicado: "0.SOLICITUD VIABILIDAD SI SI CMA 010 2026"; Nombre duplicado: "1.AVISO DE CONVOCATORIA PUBLICA SI SI CMA 010 2026"; Nombre duplicado: "2.ESTUDIO DEL SECTOR SI SI CMA 010 2026" |
| Agente 3 | Sin duplicados | `CO1.REQ.11154222` | Nombre duplicado: "F6 PagoSS Aportes ISocialMenCV1"; Nombre duplicado: "1. ESTUDIO DEL SECTOR SAMC 002 2026"; Nombre duplicado: "F6 PagoSS Aportes ISocialMenCV1"; Nombre duplicado: "A5 MinutaContrato ISocialMenCV1"; Nombre duplicado: ". F10 ManifestInteres ISocialMenCV1"; Nombre duplicado: "2. ESTUDIOS PREVIOS SAMC 002 2026"; Nombre duplicado: ". F8 FactoresDesemp ISocialMenCV1"; Nombre duplicado: ". Form PropEconomica ISocialMenCV1"; Nombre duplicado: "2. ESTUDIOS PREVIOS SAMC 002 2026" |
| Agente 3 | Nada obligatorio sin negación | `CO1.REQ.11176401` | Se detectaron afirmaciones sin negación: "- Sugiere matriz con lineamientos del personal requerido." | "- Sugiere matriz con lineamientos del personal requerido." |

## 4. Desglose de Consumo de Tokens y Costos

| Tarea / Fase | Tokens Entrada | Tokens Salida Visible | Tokens Facturados (Total) | Costo Estimado |
|---|:---:|:---:|:---:|:---:|
| **Agente 2 (resumidor)** | 44.314 | 8.930 | 75.617 | $ 0.1422 USD |
| **Agente 3 (documentos - estándar)** | 53.667 | 10.243 | 96.761 | $ 0.1688 USD |
| **Agente 3 (--siempre-agente, 3 casos)** | 16.113 | 3.456 | 29.745 | $ 0.0530 USD |
| **TOTAL CONSOLIDADO** | **114.094** | **22.629** | **202.123** | **$ 0.3640 USD** |

## 5. Lo que NO se pudo verificar (Limitaciones Objetivas)

1. **Contenido interno del pliego oficial de condiciones**: El portal transaccional de SECOP II (`community.secop.gov.co`) se encuentra tras Google ReCaptcha y no es accesible por scraping automatizado. No es posible contrastar si los requisitos exigidos en el pliego real difieren de lo indexado en datos abiertos.
2. **Validez jurídica en tiempo real de los anexos indexados**: El dataset abierto `dmgg-8hin` refleja nombres de archivos con posible desfase de indexación de hasta 24-48 horas respecto al momento de publicación del proceso.
3. **Completitud exhaustiva de la lista de documentos**: La lista orientativa se deriva del catálogo general de referencia y de los nombres de anexos conocidos; los pliegos particulares pueden contener exigencias adicionales no determinables sin lectura humana directa.
