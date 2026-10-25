# Reporte de Evaluación Científica — Agente 1 (Filtrador)
> **Ejecución ID**: `20261024-193537_55e6` | **Fecha**: 2026-10-25T00:38:48.501Z | **Tipo**: **LINEA_BASE**
> **Hash Prompt**: `c9671b7458` | **Repeticiones**: 1

## 1. Métricas Principales (Bloque A — 40 Casos Post-Prefiltro)
| Métrica | Valor | Interpretación |
| :--- | :---: | :--- |
| **Exactitud (Accuracy)** | **85.0%** | Aciertos exactos en la matriz 3x3 (34/40) |
| **Precisión ("si")** | **80.6%** | De lo que el modelo marcó "si", cuánto era oportunidad real |
| **Exhaustividad / Recall ("si")** | **100.0%** | De las oportunidades reales, cuántas detectó el modelo |
| **Useful Recall ("si" + "dudoso")** | **100.0%** | Oportunidades reales salvadas (no descartadas de plano) |
| **Falsos Positivos Graves** | **3** | Casos donde Humano='no' y Modelo='si' |
| **Oportunidades Perdidas** | **0** | Casos donde Humano='si' y Modelo='no' |
| **Participación "Dudoso" (Modelo)** | **0.0%** | Frecuencia con la que el modelo declara incertidumbre |
| **Participación "Dudoso" (Humano)** | **7.5%** | Frecuencia de ambigüedad en el Ground Truth |

## 2. Matriz de Confusión 3x3
| Ground Truth (Humano) \ Predicción Modelo | Modelo "si" | Modelo "no" | Modelo "dudoso" | Total Humano |
| :--- | :---: | :---: | :---: | :---: |
| **Humano "si"** | **25** | 0 | 0 | **25** |
| **Humano "no"** | 3 | **9** | 0 | **12** |
| **Humano "dudoso"** | 3 | 0 | **0** | **3** |
| **Total Modelo** | **31** | **9** | **0** | **40** |

## 3. Auditoría del Pre-Filtro (Bloque B — 15 Casos Descartados)
Analiza qué reglas descartaron procesos que el evaluador humano consideró válidos o dudosos (*Falsos Descartes*):
| Regla de Descarte | Total Casos | Humano "si" | Humano "dudoso" | Humano "no" | Tasa Falsos Descartes |
| :--- | :---: | :---: | :---: | :---: | :---: |
| `estado_cerrado` | 9 | 9 | 0 | 0 | **100.0%** |
| `tipo_contrato_excluido` | 2 | 1 | 0 | 1 | **50.0%** |
| `id_duplicado` | 2 | 1 | 1 | 0 | **100.0%** |
| `valor_supera_maximo` | 2 | 0 | 0 | 2 | **0.0%** |

### Detalle de Falsos Descartes por el Pre-Filtro:
- **Caso 2** (`estado_cerrado`): CONSTRUCCIÓN DE UNIDADES SANITARIAS COMPLETAS CON POZOS SÉPTICOS EN EL SECTOR RU...
  - *Etiqueta Humana*: `si` | *Nota*: "Obra civil menor en zona rural con valor y alcance razonables."
- **Caso 15** (`estado_cerrado`): Suministro de banderas y accesorios para las sedes UAECOB-SGC...
  - *Etiqueta Humana*: `si` | *Nota*: "Suministro estándar con presupuesto y alcance totalmente viables para una pyme"
- **Caso 28** (`estado_cerrado`): ALQUILER DE MAQUINARIA PARA EL RETIRO DE DERUMBES Y ARREGLO DE VIAS...
  - *Etiqueta Humana*: `si` | *Nota*: "Servicio operativo común realizable por pequeñas empresas especializadas."
- **Caso 34** (`estado_cerrado`): EL CONTRATISTA SE OBLIGA PARA CON EL DEPARTAMENTO DEL CAUCA A SUMINISTRAR PIEZAS...
  - *Etiqueta Humana*: `si` | *Nota*: "Suministro estándar con presupuesto y alcance totalmente viables para una pyme."
- **Caso 35** (`estado_cerrado`): CONTRATAR LA ADQUISICIÓN DE MOBILIARIO PARA DOTACIÓN EN LOS AMBIENTES DE FORMACI...
  - *Etiqueta Humana*: `si` | *Nota*: "Objeto claro, acotado y proporcional a la capacidad operativa de una pyme."
- **Caso 36** (`estado_cerrado`): CONTRATAR EL SERVICIO DE MANTENIMIENTO PREVENTIVO Y CORRECTIVO PARA EL ASCENSOR;...
  - *Etiqueta Humana*: `si` | *Nota*: "Servicio operativo común realizable por pequeñas empresas especializadas."
- **Caso 38** (`estado_cerrado`): CONTRATAR SERVICIOS LOGÍSTICOS;  SUMINISTRO DE BIENES Y PÓLIZAS;   PARA APOYAR A...
  - *Etiqueta Humana*: `si` | *Nota*: "Objeto claro, acotado y proporcional a la capacidad operativa de una pyme."
- **Caso 40** (`estado_cerrado`): SUMINISTRO DE REFRESCOS CARBONATADOS (GASEOSAS)...
  - *Etiqueta Humana*: `si` | *Nota*: "Suministro estándar con presupuesto y alcance totalmente viables para una pyme."
- **Caso 52** (`estado_cerrado`): PROMOCION DE LA RENDICION DE CUENTAS Y DEL ACCESO A LA INFORMACION PUBLICA MEDIA...
  - *Etiqueta Humana*: `si` | *Nota*: "Consultoría técnica o de diseño accesible para pequeñas firmas consultoras."
- **Caso 24** (`tipo_contrato_excluido`): ADMINISTRACIÓN; OPERACIÓN Y FUNCIONAMIENTO DE LA PLATAFORMA DE RODAMIENTO DEL TE...
  - *Etiqueta Humana*: `si` | *Nota*: "Objeto claro, acotado y proporcional a la capacidad operativa de una pyme."
- **Caso 16** (`id_duplicado`): COMPRA DE MENAJE E INSUMOS DE COCINA NECESARIOS PARA PARA LA DOTACIÓN...
  - *Etiqueta Humana*: `si` | *Nota*: "Suministro comercial de dotación y menaje con presupuesto y modalidad viables para una pyme."
- **Caso 18** (`id_duplicado`): SUMINISTRO DE DOTACIÓN; UNIFORMES Y PRENDAS DE REPRESENTACIÓN PARA LAS DIFERENTE...
  - *Etiqueta Humana*: `dudoso` | *Nota*: "Dotación textil viable en objeto, pero con presupuesto elevado que exige alta capacidad industrial."

## 4. Tabla de Discrepancias (Análisis de Errores — 6 Casos)
| Caso | Objeto / Nombre | Humano | Nota Humana | Modelo | Razón del Modelo |
| :---: | :--- | :---: | :--- | :---: | :--- |
| **5** | PRESTACIÓN DE SERVICIOS DE CONECTIVIDAD PARA EL … | **`no`** | Servicio de conectividad plurianual reservado a grandes operadores de telecomunicaciones. | **`si`** | Subasta de conectividad por 665 millones es abordable para un proveedor pyme de telecomunicaciones. |
| **14** | CUBIERTA PARA POLIDEPORTIVO EN LA VEREDA BAJO GE… | **`no`** | Licitación pública de obra con presupuesto elevado que exige respaldo financiero mayor. | **`si`** | Obra municipal acotada de una cubierta; valor y alcance viables para constructora pyme. |
| **17** | Suscripcon WAF Web (Presentación de oferta) | **`dudoso`** | Contrato de ciberseguridad con presupuesto alto que requiere certificación de fabricante. | **`si`** | Licenciamiento y soporte de WAF; integrador TI pyme con canal Fortinet puede ofertarlo. |
| **33** | MANTENIMIENTO PREVENTIVO Y CORRECTIVO DE LA INFR… | **`dudoso`** | Presupuesto incongruente con el objeto y la modalidad; posible error de digitación de la entidad. | **`si`** | Mantenimiento TI de menor cuantía y valor muy bajo es accesible para una pyme. |
| **39** | CONTRATO DE OBRA PÚBLICA PARA REMODELACION PARQU… | **`no`** | Presupuesto multimillonario que exige respaldo financiero de gran empresa o consorcio | **`si`** | Obra acotada de un parque; constructora mediana puede ejecutarlo y respaldarlo. |
| **44** | CORREDOR DE SEGUROS | **`dudoso`** | Falta información de cantidades y el valor no permite deducir la escala. | **`si`** | Intermediación de seguros es servicio profesional que un corredor pyme autorizado puede prestar. |

## 5. Costos y Consumo de Tokens
- **Tokens de Entrada**: 14.170
- **Tokens de Salida**: 4.065
- **Tokens Totales**: 31.172
- **Costo Total Estimado**: **$ 0.0527 USD**