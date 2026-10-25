# Guía de Etiquetado Manual para Evaluación Humana (S3-3)

> **PROPÓSITO DEL DOCUMENTO**:
> Esta guía establece los criterios de verdad de terreno (*Ground Truth*) para etiquetar manualmente los casos en `data/pruebas-reto/evaluacion/casos-sin-etiquetar.json`.
> Tu criterio como evaluador humano constituye el estándar de referencia contra el cual se medirán la precisión, el *recall* y las decisiones de descarte del Agente 1 (filtrador) y del pre-filtro de código.

---

## 1. Definición de Etiquetas para una Pyme Colombiana

El objetivo es clasificar cada proceso según si representa una **oportunidad comercial realista y viable para una pyme colombiana típica** (micro, pequeña o mediana empresa, independientemente de su sector económico):

### 🟢 `"si"` (Oportunidad Apta para Pyme)
- **Definición**: El objeto contractual es claro, acotado y realizable por una pyme con capacidad operativa habitual.
- **Señales positivas**:
  - Modalidades accesibles como **Mínima cuantía** o **Selección abreviada de menor cuantía**.
  - Si en el texto o descripción se indica explícitamente que la convocatoria está **limitada a Mipymes** o reservada a emprendedores nacionales.
  - El presupuesto y los plazos son razonables y proporcionales para suministros comunes, dotación, mantenimiento, servicios profesionales o consultoría local.
  - La complejidad técnica no requiere infraestructura mayor ni consorcios multinacionales.

### 🔴 `"no"` (No Apto para Pyme)
- **Definición**: El proceso exige una escala, respaldo financiero, infraestructura o certificaciones que una pyme no posee normalmente.
- **Señales de descarte**:
  - Presupuestos gigantescos o desproporcionados para la complejidad del objeto (p. ej. obras viales pesadas, concesiones, seguros masivos de alto riesgo).
  - Objetos orientados exclusivamente a grandes consorcios, operadores de telecomunicaciones nacionales o fabricantes directos.
  - Procesos de régimen especial o cerrados a proveedores pre-acreditados a gran escala.

### 🟡 `"dudoso"` (Información Insuficiente o Ambigua)
- **Definición**: El texto del nombre y la descripción es tan escueto, confuso o contradictorio que un analista humano no puede determinar con certeza si una pyme puede participar sin revisar documentación adicional.
- **Cuándo usarlo**:
  - Objetos demasiado genéricos (ej. "Prestar servicios varios para la entidad").
  - Si falta información crítica del alcance y el presupuesto no aclara la escala.
  - *Regla*: Usa `"dudoso"` únicamente cuando la ambigüedad sea real; si con la descripción y el valor se infiere claramente la viabilidad o inviabilidad, asigna `"si"` o `"no"`.

---

## 2. Reglas Inmutables para el Evaluador

1. **Evalúa solo con los campos visibles en la plantilla**:
   - `nombre`, `descripcion`, `entidad`, `departamento`, `modalidad`, `tipoDeContrato`, `valorCOP` y `fechaLimite`.
   - No inventes datos que no estén presentes en la ficha.
2. **Prohibido consultar salidas del modelo o LLM**:
   - No abras trazas de LangSmith, logs de ejecuciones previas ni respuestas generadas por `grok-4.6` antes de terminar todo el etiquetado. El evaluador debe ser 100% ciego.
3. **Prohibido abrir el pliego oficial en SECOP II**:
   - La prueba mide el triaje inicial de oportunidades en datos abiertos. No intentes buscar el proceso en la web ni descargar anexos.
4. **Campo `nota` obligatorio y breve**:
   - Escribe una **sola frase corta** (máximo 15-20 palabras) justificando tu elección (ej. `"Mínima cuantía de papelería, totalmente accesible"`, `"Presupuesto excesivo y obra pesada"`, `"Descripción muy vaga sin alcance definido"`).
5. **No omitir ningún caso**:
   - Todos los 55 casos del archivo deben tener `etiqueta` asignada (`"si"`, `"no"` o `"dudoso"`).

---

## 3. Consejo Metodológico

> [!TIP]
> **Etiqueta primero, revisa después**:
> 1. **Primera pasada (ritmo fluido)**: Lee el nombre, valor y modalidad y asigna tu primera evaluación analítica a los 55 casos de forma continua.
> 2. **Segunda pasada (calibración)**: Filtra y repasa rápidamente tus decisiones, prestando especial atención a los casos marcados como `"dudoso"` para confirmar si ameritan mantenerse así o si se pueden resolver en `"si"` o `"no"`.

---

## 4. Validación de la Entrega

Cuando termines de llenar el archivo [casos-sin-etiquetar.json](file:///c:/Proyectos/Agentes/Rastreador-de-oportunidades-en-SECOP-II/data/pruebas-reto/evaluacion/casos-sin-etiquetar.json), ejecuta:

```bash
pnpm evaluar:validar
```

El script verificará:
- Que ningún caso haya quedado vacío.
- Que no haya valores tipográficos inválidos.
- Que el Bloque A cumpla las condiciones mínimas de confiabilidad estadística (al menos 30 casos etiquetados, mínimo 8 `"si"` y mínimo 8 `"no"`).
- Emitirá `✅ SET DE EVALUACIÓN LISTO Y VALIDADO` únicamente si todo está en orden.
