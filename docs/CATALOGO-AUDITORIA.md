# Auditoría de Fuentes y Emisores del Catálogo de Documentos Habilitantes

> **Auditoría Técnica Automatizada**: Distinción estricta entre portal del **emisor** (quién expide el documento) y **respaldo legal** (norma oficial que exige el documento en compras públicas).
> Regla de honestidad: Una respuesta HTTP 200 del portal de una entidad solo certifica que el emisor existe y responde, **NO** que el documento sea solicitado en un pliego de contratación estatal. Todo ítem sin respaldo legal verificado lleva `condicion: 'Puede exigirse según el pliego; verificar.'`, `aplicaA: ['todas']` y `verificar: true`.

| ID Ítem | Documento | URL Emisor | Status Emisor | ¿Emisor Responde? | Respaldo Legal | Estado Final |
|---|---|---|:---:|:---:|---|:---:|
| `rut` | Registro Único Tributario (RUT) | `https://www.dian.gov.co/` | 200 | **SÍ (Portal responde)** | *Sin respaldo legal verificado en sesión* (`null`) | ✅ `catalogo_con_emisor` (verificar en pliego) |
| `existencia_representacion` | Certificado de existencia y representación legal o matrícula mercantil | `https://www.rues.org.co/` | 200 | **SÍ (Portal responde)** | *Sin respaldo legal verificado en sesión* (`null`) | ✅ `catalogo_con_emisor` (verificar en pliego) |
| `cedula_representante` | Documento de identidad del representante legal o persona natural proponente | *Sin URL de emisor* | N/A | **NO** | *Sin respaldo legal verificado en sesión* (`null`) | ⚠️ `catalogo_sin_emisor` (verificar en pliego) |
| `seguridad_social` | Certificación de pago de aportes a seguridad social y parafiscales | *Sin URL de emisor* | N/A | **NO** | *Sin respaldo legal verificado en sesión* (`null`) | ⚠️ `catalogo_sin_emisor` (verificar en pliego) |
| `antecedentes_disciplinarios` | Certificado de antecedentes disciplinarios | `https://www.procuraduria.gov.co/` | 200 | **SÍ (Portal responde)** | *Sin respaldo legal verificado en sesión* (`null`) | ✅ `catalogo_con_emisor` (verificar en pliego) |
| `antecedentes_fiscales` | Certificado de antecedentes fiscales (Boletín de Responsables Fiscales) | `https://www.contraloria.gov.co/` | N/A | **NO** | *Sin respaldo legal verificado en sesión* (`null`) | ⚠️ `catalogo_sin_emisor` (verificar en pliego) |
| `antecedentes_judiciales` | Certificado de antecedentes judiciales y medidas correctivas | `https://www.policia.gov.co/` | 200 | **SÍ (Portal responde)** | *Sin respaldo legal verificado en sesión* (`null`) | ✅ `catalogo_con_emisor` (verificar en pliego) |
| `rup` | Certificado del Registro Único de Proponentes (RUP) | `https://www.rues.org.co/` | 200 | **SÍ (Portal responde)** | *Sin respaldo legal verificado en sesión* (`null`) | ✅ `catalogo_con_emisor` (verificar en pliego) |
| `garantia_seriedad` | Garantía de seriedad de la oferta | *Sin URL de emisor* | N/A | **NO** | *Sin respaldo legal verificado en sesión* (`null`) | ⚠️ `catalogo_sin_emisor` (verificar en pliego) |
| `carta_presentacion` | Carta de presentación de la oferta y formatos anexos del pliego | *Sin URL de emisor* | N/A | **NO** | *Sin respaldo legal verificado en sesión* (`null`) | ⚠️ `catalogo_sin_emisor` (verificar en pliego) |
| `certificaciones_experiencia` | Certificaciones de experiencia previa | *Sin URL de emisor* | N/A | **NO** | *Sin respaldo legal verificado en sesión* (`null`) | ⚠️ `catalogo_sin_emisor` (verificar en pliego) |
| `estados_financieros` | Estados financieros con notas contables y certificación | *Sin URL de emisor* | N/A | **NO** | *Sin respaldo legal verificado en sesión* (`null`) | ⚠️ `catalogo_sin_emisor` (verificar en pliego) |

---
*Auditoría generada automáticamente con timeout de 10 s, 1 reintento y tasa controlada (máx 2 req/s).*
