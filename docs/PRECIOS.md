# Guía de Configuración de Precios y Calibración de Costos

> **DOCUMENTO DE GESTIÓN FINANCIERA (S3-2)**:
> Esta guía detalla cómo configurar los precios oficiales en `config/precios.json` y el procedimiento empírico para calibrar la facturación de tokens de razonamiento frente al panel del reto.

---

## 1. Dónde Encontrar los Precios en el Dashboard

Los créditos de Grok en el Reto Agente 2026 se contabilizan en dólares estadounidenses (**USD**). Para configurar las tarifas oficiales:

1. Ingrese a la plataforma oficial del Reto Agente (`https://api.reto.pltk.mx` o el dashboard proveído por la organización).
2. Diríjase a la sección de **Modelos**, **Tarifas** o **Facturación** (*Billing* / *Usage*).
3. Localice la entrada correspondiente al modelo `grok-4.6`:
   - **Precio por millón de tokens de entrada**: Tarifa por cada 1.000.000 de tokens de entrada (*prompt / input*).
   - **Precio por millón de tokens de salida**: Tarifa por cada 1.000.000 de tokens generados (*completion / output*).
4. Edite el archivo `config/precios.json` en la raíz del repositorio y reemplace los valores `null` por los números oficiales (en USD):
   ```json
   {
     "moneda": "USD",
     "actualizado": "YYYY-MM-DD",
     "fuente": "panel del reto",
     "modelos": {
       "grok-4.6": {
         "porMillonEntrada": <VALOR_ENTRADA>,
         "porMillonSalida": <VALOR_SALIDA>
       }
     }
   }
   ```

> ⚠️ **Regla Inmutable**:
> Nunca invente tarifas. Si `porMillonEntrada` o `porMillonSalida` permanecen como `null` o no están configurados, los scripts del proyecto reportarán exclusivamente cantidades de tokens y mostrarán la leyenda `"precio no configurado"`, sin calcular ningún valor monetario.

---

## 2. El Fenómeno de los Tokens de Razonamiento en Grok

En modelos de razonamiento como `grok-4.6`, la suma de `tokens_entrada + tokens_salida_visible` es menor a `tokens_total`. Esta diferencia corresponde a los tokens internos de razonamiento (*reasoning tokens* / cadena de pensamiento interna).

Dado que los gateways OpenAI-compatibles pueden facturar estos tokens de distintas formas, la herramienta de costos calcula **dos estimaciones independientes**:

- **Estimación A ("Conservadora")**:
  $$\text{Costo}_A = \frac{\text{Tokens Entrada} \times \text{Precio Entrada}}{1.000.000} + \frac{(\text{Tokens Total} - \text{Tokens Entrada}) \times \text{Precio Salida}}{1.000.000}$$
  *Asume que todo token que no es de entrada (incluyendo razonamiento) se factura a tarifa completa de salida.*

- **Estimación B ("Solo Salida Visible")**:
  $$\text{Costo}_B = \frac{\text{Tokens Entrada} \times \text{Precio Entrada}}{1.000.000} + \frac{\text{Tokens Salida Visible} \times \text{Precio Salida}}{1.000.000}$$
  *Asume que la plataforma cobra únicamente los tokens visibles en la respuesta final y no tarifa el razonamiento interno.*

---

## 3. Procedimiento de Calibración con el Panel del Reto

Para determinar con precisión científica cuál de las dos estimaciones refleja el cobro real de la plataforma, siga este procedimiento paso a paso:

1. **Lectura inicial del gasto**:
   Antes de iniciar una ejecución del pipeline, consulte el panel del reto y anote el saldo gastado acumulado (p. ej. en la pestaña de consumo).
2. **Ejecutar una corrida**:
   Ejecute una corrida del sistema con topes controlados:
   ```powershell
   pnpm start
   ```
   Anote el `ID de Ejecución` impreso en consola (ej. `20261020-172456_dec9`).
3. **Lectura final del gasto**:
   Espere a que la corrida termine y actualice la vista del panel. Reste el saldo inicial del saldo final para obtener el incremento exacto:
   $$\Delta \text{Gasto USD} = \text{Gasto Final} - \text{Gasto Inicial}$$
4. **Ejecutar la herramienta de calibración**:
   Ejecute el comando de costos pasando el identificador de la corrida y el incremento observado en el panel:
   ```powershell
   pnpm costos --ejecucion=<ID_EJECUCION> --gasto-panel-usd=<DELTA_GASTO>
   ```
5. **Interpretación del resultado**:
   El script calculará automáticamente los ratios:
   $$\text{Ratio}_A = \frac{\text{Gasto Panel}}{\text{Estimación } A} \quad \text{y} \quad \text{Ratio}_B = \frac{\text{Gasto Panel}}{\text{Estimación } B}$$
   - Si $\text{Ratio}_A \approx 1.00$, la plataforma factura el razonamiento interno a tarifa de salida (Estimación A).
   - Si $\text{Ratio}_B \approx 1.00$, la plataforma omite el cobro de razonamiento o solo factura la salida visible (Estimación B).
   - Si ambos ratios difieren sustancialmente de 1.00, revise si las tarifas en `config/precios.json` coinciden exactamente con las de su plan.

---

## 4. Opciones del Comando de Costos (`pnpm costos`)

```powershell
# Reporte general de todas las corridas históricas
pnpm costos

# Filtrar por corrida específica
pnpm costos --ejecucion=20261020-172456_dec9

# Filtrar por rango de fechas
pnpm costos --desde=2026-10-15 --hasta=2026-10-20

# Filtrar por tipo de corrida
pnpm costos --tipo=normal

# Calibración contra el gasto observado en el panel
pnpm costos --ejecucion=20261020-172456_dec9 --gasto-panel-usd=0.0450

# Proyección de costos para N unidades de trabajo (con promedio y percentil 90)
pnpm costos --proyectar=1000
```
