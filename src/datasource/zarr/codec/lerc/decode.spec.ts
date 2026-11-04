/**
 * @license
 * Copyright 2026 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import path from "node:path";
import { load } from "lerc";
import { beforeAll, expect, test } from "vitest";
import { lercChunkArray } from "#src/datasource/zarr/codec/lerc/decode.js";
import "#src/datasource/zarr/codec/lerc/resolve.js";
import { parseCodecChainSpec } from "#src/datasource/zarr/codec/resolve.js";
import { DataType } from "#src/util/data_type.js";
import { decodeLerc } from "#src/util/lerc.js";

function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

// `decodeLerc` loads the module once, with the URL of the bundled wasm; in node,
// load it first from the package.
beforeAll(async () => {
  await load({
    locateFile: () =>
      path.resolve(
        __dirname,
        "../../../../../node_modules/lerc/lerc-wasm.wasm",
      ),
  });
});

const DATA_TYPES: Record<string, DataType> = {
  int8: DataType.INT8,
  uint8: DataType.UINT8,
  int16: DataType.INT16,
  uint16: DataType.UINT16,
  int32: DataType.INT32,
  uint32: DataType.UINT32,
  float32: DataType.FLOAT32,
  float64: DataType.FLOAT32,
};

// Written by imagecodecs 2026.8.16's `lerc_encode`. `expected` is what its
// `lerc_decode(masks=False)` returns, little-endian.
const CASES = [
  {
    name: "uint8",
    shape: [12, 16],
    dtype: "uint8",
    encoded:
      "TGVyYzIgBAAAALPfSQMMAAAAEAAAAAEAAADAAAAACAAAANsAAAABAAAAAAAAAAAA4D8AAAAAAAAAAAAAAAAAQG1AAAAAAADqAAEEAAAAAAEAAP8AAAAUAQAAhBVnVVQzM0NWhAeICGSGEAaVge5ygQABQAAAgAEJi6gLSsdNIj72KKv10b1QKDJ75GvAiLUdJQgwzc5rSjq1DotamuD+lodQERlVbx9PwkdjeD0deF3pLrnIZOh8YCAYREHfRJz7sIxCTWpC4MphdiAe1o+76tRwEAAAAIAAAAAA",
    expected:
      "AAkWFyMpLTM5Q0lRWlxjbw0aICcpMTk8RVFRWmFpb3QWIywwNT1FSk5bXGRrcXuAJy4zNkRKS1haYWtydYKLji40PERQVllgZXJ1fIGKkps9QkxTWlpmcHR3f4ySlZ6jQkpRXmBscneBho+PmaKpslVcX2dud3iBhYyUnaeus7paY2ZteHyEjpKcnq2su8DGZG52f4eNjpSgoq60t8DFznZ3fImNlZuhrLO5wcPJ0N1+h4mSmZ6psbK9w8bT1t3q",
  },
  {
    name: "int8",
    shape: [12, 16],
    dtype: "int8",
    encoded:
      "TGVyYzIgBAAAALRwJmcMAAAAEAAAAAEAAADAAAAACAAAAAkBAAAAAAAAAAAAAAAA4D8AAAAAAABgwAAAAAAAgFpAAAAAAIBqAYCJlpejqa2zucPJ0drc4++NmqCnqbG5vMXR0drh6e/0lqOssLW9xcrO29zk6/H7AKeus7bEysvY2uHr8vUCCw6utLzE0NbZ4OXy9fwBChIbvcLM09ra5vD09/8MEhUeI8LK0d7g7PL3AQYPDxkiKTLV3N/n7vf4AQUMFB0nLjM62uPm7fj8BA4SHB4tLDtARuTu9v8HDQ4UICIuNDdARU729/wJDRUbISwzOUFDSVBd/gcJEhkeKTEyPUNGU1Zdag==",
    expected:
      "gImWl6OprbO5w8nR2tzj742aoKepsbm8xdHR2uHp7/SWo6ywtb3Fys7b3OTr8fsAp66ztsTKy9ja4evy9QILDq60vMTQ1tng5fL1/AEKEhu9wszT2trm8PT3/wwSFR4jwsrR3uDs8vcBBg8PGSIpMtXc3+fu9/gBBQwUHScuMzra4+bt+PwEDhIcHi0sO0BG5O72/wcNDhQgIi40N0BFTvb3/AkNFRshLDM5QUNJUF3+BwkSGR4pMTI9Q0ZTVl1q",
  },
  {
    name: "uint16",
    shape: [12, 16],
    dtype: "uint16",
    encoded:
      "TGVyYzIgBAAAACFC+R0MAAAAEAAAAAEAAADAAAAACAAAAMsBAAADAAAAAAAAAAAA4D8AAAAAABiYQAAAAAAgPe1AAAAAAAYG6ekBBgYLCxISGhoeHikpKys3Nzk5Q0NISFVVV1ddXWhoaWkLCxMTGRkiIicnLi49PUJCRkZPT1RUWlpnZ25ucXF6ehkZHR0oKC0tNDQ7O0hISkpOTltbXl5lZXJyeXl8fH9/IyMvLzc3PDxEREtLTU1YWFtbaGhnZ3BwdXV+foqKkpItLTY2OztBQUlJVVVdXWNjampsbHNzgYGFhYmJkZGWlj09QkJKSlNTVVVfX2lpbW11dXl5gYGIiJKSlpahoaenSEhNTVZWW1tfX2VlbGx2dn9/gYGJiZaWl5egoKursrJRUVtbYmJiYmlpdXV5eYGBioqOjpiYoqKnp62tt7e7u11dY2Nra3Nzd3d/f4mJjY2SkpycpKSrq7CwtbW/v8LCZmZtbXR0f3+Dg4iIlZWYmJ6eoqKvr7S0v7+/v8zM0tJ2dnp6hISJiYyMkpKdnaGhpqa0tLi4vr7FxczM2NjX13l5g4OLi5KSlZWioqamq6u3t729wcHMzM7O1tbi4unp",
    expected:
      "BgYLCxISGhoeHikpKys3Nzk5Q0NISFVVV1ddXWhoaWkLCxMTGRkiIicnLi49PUJCRkZPT1RUWlpnZ25ucXF6ehkZHR0oKC0tNDQ7O0hISkpOTltbXl5lZXJyeXl8fH9/IyMvLzc3PDxEREtLTU1YWFtbaGhnZ3BwdXV+foqKkpItLTY2OztBQUlJVVVdXWNjampsbHNzgYGFhYmJkZGWlj09QkJKSlNTVVVfX2lpbW11dXl5gYGIiJKSlpahoaenSEhNTVZWW1tfX2VlbGx2dn9/gYGJiZaWl5egoKursrJRUVtbYmJiYmlpdXV5eYGBioqOjpiYoqKnp62tt7e7u11dY2Nra3Nzd3d/f4mJjY2SkpycpKSrq7CwtbW/v8LCZmZtbXR0f3+Dg4iIlZWYmJ6eoqKvr7S0v7+/v8zM0tJ2dnp6hISJiYyMkpKdnaGhpqa0tLi4vr7FxczM2NjX13l5g4OLi5KSlZWioqamq6u3t729wcHMzM7O1tbi4unp",
  },
  {
    name: "int16",
    shape: [12, 16],
    dtype: "int16",
    encoded:
      "TGVyYzIgBAAAAOpaxnEMAAAAEAAAAAEAAADAAAAACAAAAMsBAAACAAAAAAAAAAAA4D8AAAAAwAvdwAAAAACAbNtAAAAAANGLsm0B0YvYkuCa6qTuqPq0+7UEvxDLEs0c1yXgJuEt6Dn0QPvinOWf8Kr1r/exBL8Hwg/KGNMh3CjjMOsx7Dv2RP9IA+qk9K71rwO+CcQQyxHMF9Ij3iznLukz7jz3RQBJBFAL8av5swG8CMMOyRvWIdwi3TDrNO848z75SQROCVcSWhX8tgfCDMcUzxvWJeAp5DPuNfBA+0gDUAtXEloVXhlnIg7JEcwW0R7ZJuEr5jfyQPtE/0oFTQhXEmAbYx5qJXcyFdAa1SXgLegu6T34QPtLBkoFVhFbFmQfbilwK3k0gj0f2ivmL+o070H8Qv1KBVYRVRBcF2YhcSx2MXw3gj2NSDDrN/I59D34TAdNCFkUYRxlIGcidjF9OH86i0aKRZhTO/ZB/EUASwZVEFwXZSBrJm4pdTB+OYE8iEOWUZlUol1GAUYBVA9XEmEcYh1qJXEsfTiAO4ZBk06ZVKBbpWCpZEoFWBNYE14ZaCNzLnk0fTiCPYlElVCdWKRfqGOxbLJt",
    expected:
      "0YvYkuCa6qTuqPq0+7UEvxDLEs0c1yXgJuEt6Dn0QPvinOWf8Kr1r/exBL8Hwg/KGNMh3CjjMOsx7Dv2RP9IA+qk9K71rwO+CcQQyxHMF9Ij3iznLukz7jz3RQBJBFAL8av5swG8CMMOyRvWIdwi3TDrNO848z75SQROCVcSWhX8tgfCDMcUzxvWJeAp5DPuNfBA+0gDUAtXEloVXhlnIg7JEcwW0R7ZJuEr5jfyQPtE/0oFTQhXEmAbYx5qJXcyFdAa1SXgLegu6T34QPtLBkoFVhFbFmQfbilwK3k0gj0f2ivmL+o070H8Qv1KBVYRVRBcF2YhcSx2MXw3gj2NSDDrN/I59D34TAdNCFkUYRxlIGcidjF9OH86i0aKRZhTO/ZB/EUASwZVEFwXZSBrJm4pdTB+OYE8iEOWUZlUol1GAUYBVA9XEmEcYh1qJXEsfTiAO4ZBk06ZVKBbpWCpZEoFWBNYE14ZaCNzLnk0fTiCPYlElVCdWKRfqGOxbLJt",
  },
  {
    name: "uint32",
    shape: [12, 16],
    dtype: "uint32",
    encoded:
      "TGVyYzIgBAAAAPeKmKkMAAAAEAAAAAEAAADAAAAACAAAAE8DAAAFAAAAAAAAAAAA4D8AAAAQEBCAQQAAwNzc3OxBAAAAAAICAgLm5ubmAQICAgILCwsLFBQUFBcXFxciIiIiKSkpKS8vLy84ODg4QEBAQERERERLS0tLVFRUVFhYWFhjY2NjY2NjY2xsbGwMDAwMFRUVFR0dHR0iIiIiKSkpKTY2NjY2NjY2QEBAQEpKSkpNTU1NVVVVVVhYWFhhYWFhaGhoaHBwcHB2dnZ2GRkZGR0dHR0nJycnMDAwMDIyMjI7Ozs7RkZGRk9PT09UVFRUXFxcXF9fX19mZmZmbm5ubnFxcXF+fn5+g4ODgycnJycsLCwsMzMzMzk5OTlCQkJCSUlJSU9PT09SUlJSYWFhYWdnZ2doaGhodnZ2dnp6enqBgYGBioqKipCQkJAxMTExMzMzM0FBQUFHR0dHTk5OTlFRUVFdXV1dXV1dXWhoaGhwcHBweXl5eX9/f3+Dg4ODj4+Pj5GRkZGWlpaWOjo6Oj8/Pz9HR0dHUFBQUFVVVVVeXl5eaGhoaHBwcHBxcXFxfX19fX9/f3+Hh4eHk5OTk5mZmZmZmZmZpKSkpEdHR0dPT09PWFhYWFpaWlpmZmZma2tra25ubm57e3t7fHx8fIWFhYWNjY2Nl5eXl56enp6goKCgq6urq66urq5TU1NTXFxcXF5eXl5qampqa2tra3V1dXV3d3d3g4ODg4uLi4uSkpKSmpqampycnJylpaWlrKysrLKysrK8vLy8XV1dXWdnZ2dqampqc3Nzc3V1dXV/f39/hYWFhY6Ojo6Tk5OTmZmZmaSkpKSpqamps7Ozs7S0tLS+vr6+wsLCwmVlZWVubm5ueHh4eH9/f3+Dg4ODh4eHh5CQkJCcnJycoKCgoKWlpaWsrKystLS0tLu7u7u/v7+/y8vLy83Nzc1vb29vd3d3d39/f3+FhYWFjY2NjZmZmZmbm5ubo6Ojo6urq6uzs7Oztra2tsDAwMDGxsbGysrKytPT09PZ2dnZeXl5eYaGhoaMjIyMlJSUlJiYmJifn5+fp6enp66urq64uLi4urq6ur+/v7/JycnJ1dXV1dra2trj4+Pj5ubm5g==",
    expected:
      "AgICAgsLCwsUFBQUFxcXFyIiIiIpKSkpLy8vLzg4ODhAQEBAREREREtLS0tUVFRUWFhYWGNjY2NjY2NjbGxsbAwMDAwVFRUVHR0dHSIiIiIpKSkpNjY2NjY2NjZAQEBASkpKSk1NTU1VVVVVWFhYWGFhYWFoaGhocHBwcHZ2dnYZGRkZHR0dHScnJycwMDAwMjIyMjs7OztGRkZGT09PT1RUVFRcXFxcX19fX2ZmZmZubm5ucXFxcX5+fn6Dg4ODJycnJywsLCwzMzMzOTk5OUJCQkJJSUlJT09PT1JSUlJhYWFhZ2dnZ2hoaGh2dnZ2enp6eoGBgYGKioqKkJCQkDExMTEzMzMzQUFBQUdHR0dOTk5OUVFRUV1dXV1dXV1daGhoaHBwcHB5eXl5f39/f4ODg4OPj4+PkZGRkZaWlpY6Ojo6Pz8/P0dHR0dQUFBQVVVVVV5eXl5oaGhocHBwcHFxcXF9fX19f39/f4eHh4eTk5OTmZmZmZmZmZmkpKSkR0dHR09PT09YWFhYWlpaWmZmZmZra2trbm5ubnt7e3t8fHx8hYWFhY2NjY2Xl5eXnp6enqCgoKCrq6urrq6urlNTU1NcXFxcXl5eXmpqampra2trdXV1dXd3d3eDg4ODi4uLi5KSkpKampqanJycnKWlpaWsrKyssrKysry8vLxdXV1dZ2dnZ2pqampzc3NzdXV1dX9/f3+FhYWFjo6OjpOTk5OZmZmZpKSkpKmpqamzs7OztLS0tL6+vr7CwsLCZWVlZW5ubm54eHh4f39/f4ODg4OHh4eHkJCQkJycnJygoKCgpaWlpaysrKy0tLS0u7u7u7+/v7/Ly8vLzc3NzW9vb293d3d3f39/f4WFhYWNjY2NmZmZmZubm5ujo6Ojq6urq7Ozs7O2tra2wMDAwMbGxsbKysrK09PT09nZ2dl5eXl5hoaGhoyMjIyUlJSUmJiYmJ+fn5+np6enrq6urri4uLi6urq6v7+/v8nJycnV1dXV2tra2uPj4+Pm5ubm",
  },
  {
    name: "int32",
    shape: [12, 16],
    dtype: "int32",
    encoded:
      "TGVyYzIgBAAAAKhGhYMMAAAAEAAAAAEAAADAAAAACAAAANUBAAAEAAAAAAAAAAAA4D8AAAAAoCfjwAAAAADA6NFAAAAAAMNm//+jRwAAAAHDZv//j0AAgIJCRGRi8vExMamoaGgICAgIBqaklJKamdHQdnYWlpBQSAgF9fLKyRUVmZgmppUVDc3GFhQ0Mjo5oaArKxubjk5ImJSMil5dubg5uZ3d0dHJeXXd2oaF2dhERCSklPTqurVVU8fF6+pPz6np1nZsbGaWk+/t+/qF/J+QQAAABAQPDxgYICAiIikpNDQPDxMTHR0kJCQkMDA1NTk5EhIfHyAgKysuLjw8Q0NLSyQkKyszMzIyOTlFRUpKVFQqKjU1OjpCQkhITExTU1lZMzNBQUZGTk5VVVhYXV1nZ0ZGSEhPT1RUXFxiYm1tdHRRUVhYXFxgYGhobGxzc4KCgRu/jyAAgIKChERC4uEBAZ2cbGwJCQtLRwcElJKKidHQeHgbGw9PSCglJSPz8RERi4okpJUVC8vGBgQMCiIhpaSFV/uPIAAAAMDDQ0JycenooKBaWgkJCMjFZWMjImJhubh2dhCQi0tIyMS0spqZ7eyKiiKikpKLS0bW0xsaIiGZmA==",
    expected:
      "w2b//8hr///Ud///1nn//+KF///pjP//7ZD///ea///8n///AKT//wuv//8UuP//HMD//x7C//8lyf//MNT//8tu///Tdv//237//+iL///sj///9pn///ea///+of//C6///w+z//8Zvf//IMT//yDE//8s0P//MdX//zXZ///ZfP//5If//+SH///rjv//8pX///yf//8IrP//D7P//w6y//8bv///HMD//yfL//8qzv//ONz//z/j//9H6///6Yz//+6R///3mv//+Zz//wSo//8Jrf//EbX//xO3//8gxP//J8v//y/T//8u0v//Ndn//0Hl//9G6v//UPT//+6R///5nP///aD//wWp//8MsP//FLj//xq+//8fw///Jsr//zHV//822v//PuL//0To//9I7P//T/P//1X5///8n////qH//wqu//8Rtf//Gr7//x7C//8kyP//L9P//y/T//894f//Qub//0ru//9R9f//VPj//1n9//9jBwAAB6v//wuv//8Vuf//Gr7//x7C//8t0f//NNj//zjc//9C5v//ROj//0vv//9Q9P//WPz//14CAABpDQAAcBQAABK2//8Wuv//HsL//ybK//8pzf//Ndn//z7i//9A5P//TfH//1T4//9Y/P//XAAAAGQIAABoDAAAbxMAAH4iAAAbv///IMT//y3R//8t0f//Od3//zvf//9C5v//UfX//1f7//9X+///ZgoAAGkNAABuEgAAdBgAAH8jAACEKAAAJMj//zHV//843P//O9///0To//9M8P//T/P//1f7//9gBAAAZwsAAG4SAAByFgAAeR0AAIMnAACFKQAAkjYAADba//853f//POD//0To//9N8f//Wf3//18DAABgBAAAZwsAAG4SAAB4HAAAfSEAAIImAACKLgAAkjYAAJxAAAA/4///Rur//0fr//9R9f//W////1wAAABjBwAAbREAAHkdAAB8IAAAhSkAAIktAACUOAAAmj4AAJ9DAACjRwAA",
  },
  {
    name: "float32",
    shape: [12, 16],
    dtype: "float32",
    encoded:
      "TGVyYzIgBAAAAD3EzcAMAAAAEAAAAAEAAADAAAAACAAAAE8DAAAGAAAAAAAAAAAAAAAAAAAgGBiYPwAAACAdHe0/AAAAAMHAwDzp6Gg/AcHAwDzBwEA98fBwPbm4uD35+Pg9qagoPrW0ND7Z2Fg+6ehoPoeGhj6ZmJg+paSkPrm4uD65uLg+y8rKPtnY2D6xsDA9wcDAPeHg4D2hoCA+nZwcPs3MTD7p6Gg+gYCAPo2MjD6XlpY+q6qqPrm4uD7NzMw+1dTUPuno6D739vY+0dDQPYWEBD6xsDA+rawsPuHgYD6DgoI+gYCAPpmYmD6fnp4+ubi4PsnIyD7T0tI+1dTUPu/u7j79/Pw+hIMDP5WUFD6trCw+3dxcPvHwcD6BgIA+k5KSPp+enj6zsrI+w8LCPs3MzD7T0tI+4eDgPvX09D6FhAQ/i4oKP4yLCz/JyEg+1dRUPu3sbD6Lioo+nZycPqempj69vLw+y8rKPtnY2D7h4OA+9fT0PvX09D6JiAg/jo0NP5CPDz+amRk/3dxcPomIiD6TkpI+o6KiPq2srD63trY+0dDQPt3c3D7t7Ow+8fDwPoaFBT+HhgY/j44OP5qZGT+fnh4/p6YmP42MjD6bmpo+sbCwPr28vD69vLw+0dDQPtnY2D719PQ++/r6PoeGBj+Qjw8/kZAQP52cHD+joiI/rawsP6+uLj+npqY+raysPsXExD7Pzs4+1dTUPuXk5D739vY+hIMDP4uKCj+VlBQ/l5YWP5ybGz+qqSk/rq0tP7CvLz+7ujo/v76+Ps3MzD7Z2Ng+6ejoPvPy8j77+vo+h4YGP5KRET+SkRE/mZgYP6alJT+pqCg/tbQ0P7W0ND+8uzs/xsVFP8nIyD7V1NQ+6ejoPvPy8j6DggI/jIsLP5OSEj+cmxs/o6IiP6OiIj+trCw/uLc3P7y7Oz/BwEA/yMdHP9PSUj/r6uo+8fDwPoKBAT+Ligo/kI8PP5OSEj+amRk/oJ8fP62sLD+1tDQ/u7o6P7++Pj/DwkI/y8pKP9jXVz/Y11c/+/r6PomICD+Qjw8/kI8PP5iXFz+dnBw/rKsrP7CvLz+ysTE/u7o6P8PCQj/KyUk/0dBQP93cXD/c21s/6ehoPw==",
    expected:
      "wcDAPMHAQD3x8HA9ubi4Pfn4+D2pqCg+tbQ0PtnYWD7p6Gg+h4aGPpmYmD6lpKQ+ubi4Prm4uD7Lyso+2djYPrGwMD3BwMA94eDgPaGgID6dnBw+zcxMPunoaD6BgIA+jYyMPpeWlj6rqqo+ubi4Ps3MzD7V1NQ+6ejoPvf29j7R0NA9hYQEPrGwMD6trCw+4eBgPoOCgj6BgIA+mZiYPp+enj65uLg+ycjIPtPS0j7V1NQ+7+7uPv38/D6EgwM/lZQUPq2sLD7d3Fw+8fBwPoGAgD6TkpI+n56ePrOysj7DwsI+zczMPtPS0j7h4OA+9fT0PoWEBD+Ligo/jIsLP8nISD7V1FQ+7exsPouKij6dnJw+p6amPr28vD7Lyso+2djYPuHg4D719PQ+9fT0PomICD+OjQ0/kI8PP5qZGT/d3Fw+iYiIPpOSkj6joqI+raysPre2tj7R0NA+3dzcPu3s7D7x8PA+hoUFP4eGBj+Pjg4/mpkZP5+eHj+npiY/jYyMPpuamj6xsLA+vby8Pr28vD7R0NA+2djYPvX09D77+vo+h4YGP5CPDz+RkBA/nZwcP6OiIj+trCw/r64uP6empj6trKw+xcTEPs/Ozj7V1NQ+5eTkPvf29j6EgwM/i4oKP5WUFD+XlhY/nJsbP6qpKT+urS0/sK8vP7u6Oj+/vr4+zczMPtnY2D7p6Og+8/LyPvv6+j6HhgY/kpERP5KRET+ZmBg/pqUlP6moKD+1tDQ/tbQ0P7y7Oz/GxUU/ycjIPtXU1D7p6Og+8/LyPoOCAj+Miws/k5ISP5ybGz+joiI/o6IiP62sLD+4tzc/vLs7P8HAQD/Ix0c/09JSP+vq6j7x8PA+goEBP4uKCj+Qjw8/k5ISP5qZGT+gnx8/rawsP7W0ND+7ujo/v74+P8PCQj/Lyko/2NdXP9jXVz/7+vo+iYgIP5CPDz+Qjw8/mJcXP52cHD+sqys/sK8vP7KxMT+7ujo/w8JCP8rJST/R0FA/3dxcP9zbWz/p6Gg/",
  },
  {
    name: "float32, lossy",
    shape: [12, 16],
    dtype: "float32",
    encoded:
      "TGVyYzIgBAAAAGPdvG8MAAAAEAAAAAEAAADAAAAACAAAAN8AAAAGAAAAexSuR+F6hD8AAAAgEBBwPwAAAIB8fOw/AAAAAIGAgDvk42M/AAGBgIA7hUBAkGJOUoIYc9Ri5SCkWHsnJcbai2ox956UyzkIJa3uwUhrxS/KWi3WBeXkZD6FQGAMchBSoxSUEmvlHLWYewipxR6ESjHnopyMPQglre69OOnFD0pa780Bt7a2PoUgQAxiDFKCmIPUYqQcpFZzB6XF3IsFmJcXP4QgEDJkp0FVl7pTdrnsh5ns/g==",
    expected:
      "gYCAOxrnMz0S36s91dTUPZfK/T0tYBM+8FU8PtHQUD7l5GQ+xCqRPsQqkT41aJs+hyC6PvhdxD74XcQ+2djYPhrnMz0S36s9l8r9PZfK/T0tYBM+0dBQPrJLZT6Txnk+xCqRPqalpT6mpaU++F3EPmibzj5om84+ulPtPiuR9z7V1NQ9LWATPg7bJz4O2yc+0dBQPpPGeT66IIc+nJubPqalpT6HILo+hyC6PtnY2D5KFuM+ulPtPk7nAD8GBgY/LWATPvBVPD7wVTw+k8Z5PpPGeT66IIc+nJubPn0WsD74XcQ++F3EPtnY2D5KFuM+ulPtPgYGBj++JAs/viQLP9HQUD6yS2U+k8Z5PitekT6cm5s+nJubPu5Tuj7uU7o+2djYPtnY2D66U+0+TucAP07nAD93QxA/L2IVP+eAGj+yS2U+K16RPitekT4M2aU+DNmlPu5Tuj7Pzs4+PwzZPrpT7T66U+0+BgYGP74kCz++JAs/L2IVP6CfHz9YviQ/K16RPpybmz4M2aU+fRawPs/Ozj4/DNk+PwzZPpHE9z5O5wA/BgYGPwYGBj93QxA/54AaP6CfHz/J+y4/gRo0P5ybmz59FrA+7lO6Pj8M2T4/DNk+sEnjPpHE9z65HwY/BgYGP74kCz8vYhU/oJ8fP1i+JD/J+y4/yfsuPzk5OT+3trY+mDHLPglv1T56rN8+Wyf0Plsn9D4eUQQ/j44OP5iXFz9Qthw/CdUhP8HzJj95Eiw/6k82P6JuOz/Lyko/mDHLPnqs3z5bJ/Q+y2T+Ph5RBD+Pjg4/R60TP//LGD9Qthw/eRIsPzIxMT8yMTE/om47PxOsRT/Lyko/hOlPP3qs3z7q6ek+y2T+Ph5RBD+Pjg4/R60TP7jqHT9wCSM/wfMmPzIxMT/qTzY/om47PxOsRT+E6U8/PAhVP6xFXz/LZP4+HlEEP9ZvCT9HrRM//8sYP3AJIz8oKCg/mWUyP6JuOz9bjUA/E6xFPxOsRT88CFU/rEVfP6xFXz/k42M/",
  },
  {
    name: "float64",
    shape: [12, 16],
    dtype: "float64",
    encoded:
      "TGVyYzIgBAAAADnVwb0MAAAAEAAAAAEAAADAAAAACAAAAFcGAAAHAAAAAAAAAAAAAAAAAADwRKuhP5qZmTlpnO8/AAAAAAAAAPBEq6E/mpmZOWmc7z8BAAAA8ESroT+amZmJuOuuPzQzMyMWFrY/Z2ZmVueAuj80MzNjU1PDPwAAALAHbsQ/zczMvH5LyD8BAACwEnnPPzQzM2s2A9A/Z2ZmdgCa0z9nZmbWYfvUP83MzPy7iNU/mpmZCTNm2T+amZlplMfaP2dmZrZI4ts/Z2ZmFqpD3T+amZmJuOuuP2dmZtZh+7Q/mpmZibjrvj80MzMjFhbGP83MzLx+S8g/mpmZyfUozD+amZmJuOvOP83MzKQ919A/mpmZKUx/0j/NzMz8u4jVP5qZmanRBNg/mpmZCTNm2T80MzOjm5vbP83MzDwE0d0/AQAAsBJ53z/NzMykPdfgPzQzM2s2A8A/NDMzY1NTwz80MzMjFhbGPzQzM6Obm8s/NDMzY15ezj+amZmRkJDQP2dmZhafONI/NDMzw7S01D/NzMxcHerWP5qZmQkzZtk/mpmZCTNm2T9nZmYWqkPdP2dmZnYLpd4/NDMzG+ez4D80MzMb57PgP2dmZhafOOI/AAAAsAduxD+amZlJcKPGP2dmZlbngMo/NDMzazYD0D/NzMw8+cXSPzQzM8O0tNQ/zczM/LuI1T80MzODd3fXPwEAADCN89k/AQAAkO5U2z/NzMzcom/cPzQzM8O/v98/AAAACDpt4D+amZlBQUHhPzQzM7OiouI/AAAAAFe94z9nZmZW54DKP5qZmcn1KMw/AAAAuOod0T+amZkpTH/SP2dmZtZh+9Q/mpmZSXCj1j+amZmp0QTYPzQzM6Obm9s/NDMzo5ub2z/NzMw8BNHdP83MzKQ91+A/zczMpD3X4D/NzMw8+cXiP2dmZnYAmuM/AAAAAFe94z+amZk5XpHkP2dmZn7jSdA/AAAA8ESr0T9nZmbWYfvUP83MzFwd6tY/NDMz49jY2D80MzPj2NjYP83MzNyib9w/NDMzA/383D8BAACwEnnfP2dmZn7jSeA/AAAA8ESr4T8AAACg9VviPzQzMxMEBOQ/AAAAsAdu5D+amZmZv/LlPwEAAMAZgOY/NDMzY1NT0z8AAAAQac/VPwEAAHDKMNc/AQAAMI3z2T/NzMx8QQ7bP83MzDwE0d0/NDMzazYD4D9nZmZ+40ngP5qZmUFBQeE/NDMzA/Lx4T/NzMw8+cXiPwAAAABXveM/zczM/LuI5T8BAADAGYDmPzQzM4N3d+c/AQAAIHvh5z/NzMz8u4jVP2dmZvaFH9k/mpmZaZTH2j8BAADwT7bcPzQzM2NeXt4/zczM9Iwm4D80MzMb57PgP83MzFTuh+E/mpmZKUx/4j8AAACwB27kPwAAAGC4HuU/NDMzIxYW5j8BAABwyjDnP5qZmanRBOg/AQAAgNxC6T8BAAAwjfPpP83MzLx+S9g/AQAAkO5U2z+amZnJ9SjcP2dmZnYLpd4/Z2ZmLpT64D/NzMxU7ofhP2dmZhafOOI/mpmZia3g4z80MzPDtLTkP83MzPy7iOU/Z2ZmNsNc5j80MzPTxsbmP2dmZkbVbug/mpmZCTNm6T+amZlplMfqPwEAAOA9pOo/zczM3KJv3D/NzMw8BNHdPzQzMxvns+A/Z2ZmLpT64D/NzMxU7ofhP5qZmSlMf+I/zczM7Kl24z/NzMxMC9jkPzQzM3NlZeU/NDMzg3d35z+amZn5IFTnP2dmZvaFH+k/zczMHOCs6T9nZmZW54DqP83MzCzyvus/zczM3KJv7D80MzNrNgPgP5qZmUFBQeE/AAAAuOod4T8AAACg9VviP5qZmYmt4OM/zczMnFon5D+amZmZv/LlP2dmZjbDXOY/NDMzg3d35z9nZmZG1W7oP83MzGwv/Og/AQAAMI3z6T+amZkZRXjrP83MzNyib+w/AQAA8E+27D80MzNjXl7uP2dmZi6U+uA/Z2ZmFp844j8AAABQpgzjP2dmZnYAmuM/mpmZOV6R5D8BAADAGYDmP83MzAzOmuc/NDMzg3d35z80MzPj2NjoP83MzBzgrOk/AQAA4D2k6j/NzMzcom/sPzQzMwP9/Ow/NDMzY15e7j80MzNjXl7uP5qZmTlpnO8/",
    expected:
      "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",
  },
  {
    name: "uint8, 3 samples",
    shape: [12, 16, 3],
    dtype: "uint8",
    encoded:
      "TGVyYzIgBAAAALq7oWMMAAAAEAAAAAMAAADAAAAACAAAAPUBAAABAAAAAAAAAAAA4D8AAAAAAAAAAAAAAAAA4G9AAAAAAAIAAOL//wABBAAAAAABAAD/AAAAKAEAAIQpd2dmVUVUVEVFVVRUVVZ3B5iQiQAJghgIDmiaQoy14oT2n/vmbCgQ4gEEACBgAAMGBKUQAxE9hJqycHKTSEY5mWcdqKahGGQsySzylBXMMeeQRRIkYn3WJCkkUwyRSKaRhSdJFmMuQfiwo84eTqcowYfUNcYQF0kImwj2GAVEi3K20SxFIiFGOiw4iyCpCUToHmpoUXJJggw1FlKSKKSBMpLRQosdZYgOUFZcuxU6m9HaoWXV6lKrWdfVOusQKcSrtRliiXNitcl5hue3Ewut3d4/G3ZlhNLz8o1cmaGlXuqulK9aZTjWmI15pZatDizqdVUy7YwpKaaMptXp3Xm3m9X5pIrBp8Ms8cbrqxNmnA/iM4/Upvvjv7EuFt0/YUGHER6L/hY1oLW40WNyBQR3qsBqD8Bioiv34OCit+aGZgYmsaMJ/C/wGoFzULn4Mnyv3IvwHiD23or+H1DvPQ4Wv625foywzdAMr2F79+8BzwvKHfujPY/+yPxjrwf+OVzx2wLw0f712rvGB7/9uwAAAEAAAAAA",
    expected:
      "AgcHDhYdEhwrFzA/HUBUI0lpLlyCNGKXO3apRIG+RpLTUJ7pWawDYbwVY8Qma9Q+DR0hFSY5HzZMIEVkKlN1Ml6QOmqhRIC4SovLTpTlV6L3W7IOY8MfbNI5dd5NduphGDNIID5XJUhzMFmJNGiWQHiwR4HDR5HdUqLrWLAHYrwWasssbdw/deRaevJshP99IkVoKVF/M2OTOm6kQXy8Ro/TU5zpU6f4YLYLY8QladA7bt1Pdu1jffh2iA2QkhemMl2HOm2ZPHi2Q4jISZPYUJ71Xa8KYrsYaMwzcN5DdOdcfPpuhAiAiQ+bkB2vlzLGOHKmQIC7RYvQTZnqV64AYrsPYccnb9Q9dOBUdvJqgQB5iQmOkxylkii9nTjLp0HlR4XIUZjbUKHwXrILYMIcac8xb+BEeeZee/dvggaGiRGdkCSvmzPGpD/drE/0s1cDVZ/sWqgBX7YSZ8wmatI7eOZVe+5nfwKAiQ+RlCCslC6+mjnVpULlr1f7tWYPuGwmXrcJY8EdaM06ddtOeO5hfv52hgWLjxKhlCG2ny/KnkHiq0r1r1wEtGsgu3gzxIVKa8csa9dDcepXefJwhwKFhhOXkSCtmivCnDrVqEjnqlgBtWgWvXMmw34/xoxUz59pb+RQeOpgf/l3iAaJjBugmCW0nTPJpUDjqlL0s2AMuGofwHc2xoVLy5Jf0aJ42rOGfPdygAKEjxCYkCSunTLDnj7XqUjurFb/tWkVuHAqwYQ/x5FT05xo1KuA3beW4syu",
  },
  {
    name: "uint16, 4 samples",
    shape: [12, 16, 4],
    dtype: "uint16",
    encoded:
      "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",
    expected:
      "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",
  },
  {
    name: "float32, 3 samples, lossy",
    shape: [12, 16, 3],
    dtype: "float32",
    encoded:
      "TGVyYzIgBAAAAANjAAYMAAAAEAAAAAMAAADAAAAACAAAAEcCAAAGAAAAexSuR+F6hD8AAAAgEBBwPwAAAAAAAPA/AAAAAOHg4DyBgIA7gYCAO+jnZz///n4/AACAPwAB4eDgPIVAQIhRzElhlHJQYqMclBZz5yS1mHspLeYelGux96KkzT0oab0vylntzQGBgIA8hkDAYCCLE1GFoTSPVF3J8kSUlW3NI1WY5oESdWncJ5YVtnnhaKIaB47kubYfOJ7q+sYBwcBAPIZAAYE0kZV1BvNM1/aRTmRlnmim1LWFI9rGWzeaqgsQYYmy8WAw5woLReJILUAgzDNlBeHgYD6FQECMYlBSo5STEmvlILSYewepxd6TarH2YKSrORjnrO9BOau9UE5q7dUFgYCAO4ZAl8Z9YmmmnAeOZsq6X1iiagvLo5mubjwQqOrCAGEgrAsMxKE0MFAcCfNIg4EsDURZBYGAgDuGQKGpvgCBMCgbC4biTC5AJE1kacKhONPFgYkjWZonmhB1cSGJstXmjSYLB11Ypm48IAG/vr4+hCAQM2WXMVWYumOGuex1uNv+AYGAgDuGIKOJsq4cEOfKvsBgJKwbBwSiMDEwHAjjRAHBwMA8hiBCkTiStXkH81QYB5KPZGnfaK5V1oVm2gIFk5ISP4UgQAxiTkqCFIPSasUglVhzBiXW3IsFiYgIPoYgwHAkjCNRxLE0j1RlCfNI1JVtDiRZ2OaBBbGwMD2GIKKZtgCBNCgLC4biSG4wIA1EZYOhONK1eQ==",
    expected:
      "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",
  },
  {
    name: "constant",
    shape: [8, 8],
    dtype: "uint16",
    encoded:
      "TGVyYzIgBAAAAMC6TMEIAAAACAAAAAEAAABAAAAACAAAAEYAAAADAAAAAAAAAAAA4D8AAAAAAAAcQAAAAAAAABxAAAAAAA==",
    expected:
      "BwAHAAcABwAHAAcABwAHAAcABwAHAAcABwAHAAcABwAHAAcABwAHAAcABwAHAAcABwAHAAcABwAHAAcABwAHAAcABwAHAAcABwAHAAcABwAHAAcABwAHAAcABwAHAAcABwAHAAcABwAHAAcABwAHAAcABwAHAAcABwAHAAcABwA=",
  },
  {
    name: "float32 with a mask of invalid pixels",
    shape: [12, 16],
    dtype: "float32",
    encoded:
      "TGVyYzIgBAAAAG8uYRQMAAAAEAAAAAEAAAC2AAAACAAAADUDAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAODc3Ow/DgAAAPr//wQA8H/wf/L//wCAAAAAAOfmZj8BAAAAAMHAQD2xsLA90dDQPeHg4D2dnBw+ubg4Ps3MTD7p6Gg+g4KCPpGQkD6hoKA+s7KyPre2tj7NzMw+09LSPuHgYD25uLg94eDgPYmICD65uDg+wcBAPtXUVD6HhoY+j46OPpeWlj6zsrI+ubi4PsvKyj7Z2Ng+5eTkPvX09D65uLg9kZAQPpWUFD7FxEQ+0dBQPv38fD6JiIg+lZSUPp+enj6vrq4+ubi4PsfGxj7j4uI+7+7uPv38/D6CgQE/hYQEPq2sLD7V1FQ+3dxcPs/Ozj7R0NA+6ejoPvf29j7//v4+h4YGP4uKCj/NzEw+0dBQPvHwcD6Pjo4+397ePvPy8j6BgAA/h4YGP46NDT+Qjw8/np0dP/n4eD6FhIQ+i4qKPpuamj6pqKg+t7a2PtPS0j7Z2Ng+7+7uPvv6+j6DggI/h4YGP42MDD+VlBQ/n54eP6OiIj+VlJQ+o6KiPqOioj63trY+v76+PsvKyj7l5OQ+6ejoPvv6+j6GhQU/kZAQP5CPDz+ZmBg/pqUlP6qpKT+trCw/n56ePrGwsD65uLg+ycjIPtva2j7h4OA+8fDwPoSDAz+Miws/lJMTP5uaGj+cmxs/o6IiP6qpKT+1tDQ/vr09P7m4uD7Pzs4+3dzcPuPi4j739vY+/fz8PoaFBT+NjAw/lJMTP5qZGT+hoCA/p6YmP7KxMT+1tDQ/vbw8P8nISD/X1tY+397ePu/u7j77+vo+hIMDP4eGBj+TkhI/lpUVP6CfHz+pqCg/rq0tP7KxMT+7ujo/wsFBP8nISD/T0lI/4+LiPvX09D7//v4+i4oKP4+ODj+ZmBg/oaAgP6WkJD+pqCg/s7IyP7i3Nz++vT0/xcREP87NTT/V1FQ/29paP/Py8j6EgwM/i4oKP5OSEj+ZmBg/np0dP6emJj+urS0/uLc3P8C/Pz/DwkI/yslJP9XUVD/Z2Fg/3t1dP+fmZj8=",
    expected:
      "AAAAAMHAQD2xsLA90dDQPeHg4D2dnBw+ubg4Ps3MTD7p6Gg+g4KCPpGQkD6hoKA+s7KyPre2tj7NzMw+09LSPuHgYD25uLg94eDgPYmICD65uDg+wcBAPtXUVD6HhoY+j46OPpeWlj6zsrI+ubi4PsvKyj7Z2Ng+5eTkPvX09D65uLg9kZAQPpWUFD7FxEQ+0dBQPv38fD6JiIg+lZSUPp+enj6vrq4+ubi4PsfGxj7j4uI+7+7uPv38/D6CgQE/hYQEPq2sLD7V1FQ+3dxcPgAAAAAAAAAAAAAAAAAAAAAAAAAAz87OPtHQ0D7p6Og+9/b2Pv/+/j6HhgY/i4oKP83MTD7R0FA+8fBwPo+Ojj4AAAAAAAAAAAAAAAAAAAAAAAAAAN/e3j7z8vI+gYAAP4eGBj+OjQ0/kI8PP56dHT/5+Hg+hYSEPouKij6bmpo+qaioPre2tj7T0tI+2djYPu/u7j77+vo+g4ICP4eGBj+NjAw/lZQUP5+eHj+joiI/lZSUPqOioj6joqI+t7a2Pr++vj7Lyso+5eTkPuno6D77+vo+hoUFP5GQED+Qjw8/mZgYP6alJT+qqSk/rawsP5+enj6xsLA+ubi4PsnIyD7b2to+4eDgPvHw8D6EgwM/jIsLP5STEz+bmho/nJsbP6OiIj+qqSk/tbQ0P769PT+5uLg+z87OPt3c3D7j4uI+9/b2Pv38/D6GhQU/jYwMP5STEz+amRk/oaAgP6emJj+ysTE/tbQ0P728PD/JyEg/19bWPt/e3j7v7u4++/r6PoSDAz+HhgY/k5ISP5aVFT+gnx8/qagoP66tLT+ysTE/u7o6P8LBQT/JyEg/09JSP+Pi4j719PQ+//7+PouKCj+Pjg4/mZgYP6GgID+lpCQ/qagoP7OyMj+4tzc/vr09P8XERD/OzU0/1dRUP9vaWj/z8vI+hIMDP4uKCj+TkhI/mZgYP56dHT+npiY/rq0tP7i3Nz/Avz8/w8JCP8rJST/V1FQ/2dhYP97dXT/n5mY/",
  },
  {
    name: "uint8 with a mask of invalid pixels",
    shape: [12, 16],
    dtype: "uint8",
    encoded:
      "TGVyYzIgBAAAAHEROkoMAAAAEAAAAAEAAAC2AAAACAAAANoAAAABAAAAAAAAAAAA4D8AAAAAAAAAAAAAAAAAQG1ADgAAAPr//wQA8H/wf/L//wCAAOoAAQQAAAAAAQAA/wAAABQBAACDFXdLctvYEsZ/aIYQBivE7rIgCACGEou4C5WOm0Z87FHe96J7oTgqu+gqoIy1zm9qnF8dgM2E1mq4D89DVizj6qp7E15Wi9dTwdWq3aWRmUjn1jAYhqGgbzN4fVhGkKYrEfvKYZYRJtWPANe5IQAAAAA=",
    expected:
      "AAkWFyMpLTM5Q0lRWlxjbw0aICcpMTk8RVFRWmFpb3QWIywwNT1FSk5bXGRrcXuAJy4zNgAAAAAAYWtydYKLji40PEQAAAAAAHJ1fIGKkps9QkxTWlpmcHR3f4ySlZ6jQkpRXmBscneBho+PmaKpslVcX2dud3iBhYyUnaeus7paY2ZteHyEjpKcnq2su8DGZG52f4eNjpSgoq60t8DFznZ3fImNlZuhrLO5wcPJ0N1+h4mSmZ6psbK9w8bT1t3q",
  },
  {
    name: "uint16, LERC version 2",
    shape: [12, 16],
    dtype: "uint16",
    encoded:
      "TGVyYzIgAgAAAAwAAAAQAAAAwAAAAAgAAAC/AQAAAwAAAAAAAAAAAOA/AAAAAAAUlEAAAAAAgJzsQAAAAAABBQUODg4OFxcfHyQkMDA1NT4+QkJNTVFRVVVgYGlpbGwRERYWICAjIycnNjY8PD4+R0dPT1VVXl5lZWhobm56ehwcHx8rKywsMjI7O0RESUlWVltbYWFkZHFxd3d6eoaGIyMvLzExPDxCQkZGUFBWVltbaGhoaHBwdnZ8fIODj48tLTU1Pz9ISE5OUVFdXV5eZGRvb3V1fHyHh4qKk5OXlz8/RERFRUxMW1teXmdna2t1dXp6g4OGho+PmJidnaSkQ0NLS1dXX19lZWlpb290dHx8goKMjJeXnZ2enqamrq5RUVhYX19mZmxsdnZ+foCAiYmQkJOTnp6np66utra+vlhYX19mZnFxdHR9fYiIioqSkpmZn5+srLOzs7O+vsLCa2tsbHJye3uDg4eHjo6Xl5ycp6eurrGxvb3Dw8jI1NRycnV1hISGhouLmZmamqWlqqq1tbi4vr7CwsnJ1NTa2np6gICOjpCQnJyenqqqq6u3t8DAwsLKys7O2tri4uTk",
    expected:
      "BQUODg4OFxcfHyQkMDA1NT4+QkJNTVFRVVVgYGlpbGwRERYWICAjIycnNjY8PD4+R0dPT1VVXl5lZWhobm56ehwcHx8rKywsMjI7O0RESUlWVltbYWFkZHFxd3d6eoaGIyMvLzExPDxCQkZGUFBWVltbaGhoaHBwdnZ8fIODj48tLTU1Pz9ISE5OUVFdXV5eZGRvb3V1fHyHh4qKk5OXlz8/RERFRUxMW1teXmdna2t1dXp6g4OGho+PmJidnaSkQ0NLS1dXX19lZWlpb290dHx8goKMjJeXnZ2enqamrq5RUVhYX19mZmxsdnZ+foCAiYmQkJOTnp6np66utra+vlhYX19mZnFxdHR9fYiIioqSkpmZn5+srLOzs7O+vsLCa2tsbHJye3uDg4eHjo6Xl5ycp6eurrGxvb3Dw8jI1NRycnV1hISGhouLmZmamqWlqqq1tbi4vr7CwsnJ1NTa2np6gICOjpCQnJyenqqqq6u3t8DAwsLKys7O2tri4uTk",
  },
  {
    name: "uint16, LERC version 3",
    shape: [12, 16],
    dtype: "uint16",
    encoded:
      "TGVyYzIgAwAAAN75Pt4MAAAAEAAAAMAAAAAIAAAAvwEAAAMAAAAAAAAAAADgPwAAAAAAHJxAAAAAAGB87EAAAAAAAAEHB49AAAABgYIiIoKBAQGtrFRUDAwGhoREQ2NiQkG5uHZ2FpaOTklJRTUzo6Ht7IyMGxsSEgzs5eXj8/EpKaWkKCgaWk5ORyckVFJOTbm4N7efHxCwqCglnZqCgdPSP7+jY1JSSnp1DQuzsdvaS8unp5V1aysmdnPPzf/+BTo6j0AAgIICAyMjExJCQaWkZGQQkIpKR0dEtLKCge3sfn4ZGQ6OiurlhYPj4QEBk5IhoZWVjCwn5+MbGkJBq6ovr5sbDu7nt7SUkmJhwcA3t6Dg0HBpWVXNypKR29pGxqQkFBQLy8UdG6+t6ehPTyxsVtbM/Pauq/f1+/oAWVlmZmdnbm51dX5+hoaKimRkcHB2dn9/hoaMjJWVmZlubnx8gYGDg4qKkZGbm5+ffHyEhImJkpKdnZycpKSysgSQkJ6epKSsrK2ts7O+vsjInZ2pqa2tsrK7u8HBzc3Ozqmpr6+6uru7ysrLy9PT39+0tLu7wMDLy8/P19ff3+Pj",
    expected:
      "BwcJCRERGBgfHycnMjIxMTo6Pz9GRlNTW1tiYmNjbGwTExMTGRkhIS0tLy81NUJCSkpPT1dXXFxlZWpqdXV5eR0dJCQsLDExOjo7O0JCTU1TU1ZWZGRpaXJydnZ6eoODIiIrKzc3NjZFRUVFUVFZWVtbZWVsbHNzeHh9fYqKj48vLzs7QEBBQUlJUVFaWmNjaWlxcXJyeXmFhYyMkpKamj4+RkZHR0xMWVlaWmdncHBxcXt7fX2FhY+Pk5OenqenRkZOTlBQWVleXmhoc3N0dICAg4OKipKSlpadnaWlrq5SUlZWXV1iYmlpdXV6eoaGiYmSkpOToKCpqa+vt7e3t1lZZmZnZ25udXV+foaGioqQkJ6epKSsrK2ts7O+vsjIZGRwcHZ2f3+GhoyMlZWZmZ2dqamtrbKyu7vBwc3Nzs5ubnx8gYGDg4qKkZGbm5+fqamvr7q6u7vKysvL09Pf33x8hISJiZKSnZ2cnKSksrK0tLu7wMDLy8/P19ff3+Pj",
  },
  {
    name: "uint16, LERC version 4",
    shape: [12, 16],
    dtype: "uint16",
    encoded:
      "TGVyYzIgBAAAAF5fDyYMAAAAEAAAAAEAAADAAAAACAAAAMsBAAADAAAAAAAAAAAA4D8AAAAAABBwQAAAAACAnOxAAAAAAAEB5OQBAQEJCRYWFhYhISUlLCw1NTk5R0dKSlNTVFRcXGNjbGwPDxkZHh4mJi8vMDA4OEJCRkZSUlFRXV1gYGpqbW13dxcXHh4nJzAwNDQ9PUdHT09UVFhYY2Nqamxsd3d6eoGBISEuLjAwODhERExMT09SUl5eZWVubnV1enp9fYWFkJAxMTMzQEBJSUpKVVVeXmFhZ2dycnZ2e3uGhouLlpaXlzw8QUFISFNTVVVbW2FhbW1xcXp6fn6Kio6OmpqdnaCgRUVQUFhYXl5gYGZmdHR5eXx8iIiJiY+PlpalpamprKxUVFVVYmJiYmpqdnZ8fIKCjY2MjJSUmpqmpq6usLC3t1lZY2NsbHNzd3d/f4iIiYmQkJ+foqKlpbOzurrCwsXFaWlvb3R0eXl/f4eHlZWbm56epKSwsLCwuLi+vs3Nzc1zc3t7fHyEhJGRk5OZmaenrKy1tbi4w8PFxc7O1dXc3H19iIiKio6OmpqenqSksLC5ub6+wMDIyM/P2dnj4+Tk",
    expected:
      "AQEJCRYWFhYhISUlLCw1NTk5R0dKSlNTVFRcXGNjbGwPDxkZHh4mJi8vMDA4OEJCRkZSUlFRXV1gYGpqbW13dxcXHh4nJzAwNDQ9PUdHT09UVFhYY2Nqamxsd3d6eoGBISEuLjAwODhERExMT09SUl5eZWVubnV1enp9fYWFkJAxMTMzQEBJSUpKVVVeXmFhZ2dycnZ2e3uGhouLlpaXlzw8QUFISFNTVVVbW2FhbW1xcXp6fn6Kio6OmpqdnaCgRUVQUFhYXl5gYGZmdHR5eXx8iIiJiY+PlpalpamprKxUVFVVYmJiYmpqdnZ8fIKCjY2MjJSUmpqmpq6usLC3t1lZY2NsbHNzd3d/f4iIiYmQkJ+foqKlpbOzurrCwsXFaWlvb3R0eXl/f4eHlZWbm56epKSwsLCwuLi+vs3Nzc1zc3t7fHyEhJGRk5OZmaenrKy1tbi4w8PFxc7O1dXc3H19iIiKio6OmpqenqSksLC5ub6+wMDIyM/P2dnj4+Tk",
  },
  {
    name: "3 bands",
    shape: [3, 4, 5],
    dtype: "uint8",
    encoded:
      "TGVyYzIgBAAAAJZDZ4AEAAAABQAAAAEAAAAUAAAACAAAAF0AAAABAAAAAAAAAAAA4D8AAAAAAAAsQAAAAAAAYG9AAAAAAA77AZiCzzS9qbnu+1fOQ657X40Ok7SrTGVyYzIgBAAAANFh5MYEAAAABQAAAAEAAAAUAAAACAAAAF0AAAABAAAAAAAAAAAA4D8AAAAAAIBIQAAAAAAAYG1AAAAAADHrAUSBeDzrTa1PgM7MvIyDiDHpzKOrTGVyYzIgBAAAAIDynkYEAAAABQAAAAEAAAAUAAAACAAAAF0AAAABAAAAAAAAAAAA4D8AAAAAAAAxQAAAAAAAwG5AAAAAABH2AaJDz/ChESeuS7drpHgwvHUb7sb2",
    expected:
      "mILPNL2pue77V85DrntfjQ6TtKtEgXg8602tT4DOzLyMg4gx6cyjq6JDz/ChESeuS7drpHgwvHUb7sb2",
  },
  {
    name: "2 bands of 3 values per pixel",
    shape: [2, 4, 5, 3],
    dtype: "uint8",
    encoded:
      "TGVyYzIgBAAAAIsyFHgEAAAABQAAAAMAAAAUAAAACAAAAIkAAAABAAAAAAAAAAAA4D8AAAAAAAAUQAAAAAAAAG9AAAAAABcFFe32+AFHr8w3CpAXWjGmE6OFmZ2mmjZpGhfUiSieeTSw1hU31pS0p6Ge9Pjt9h5iX4StZ1OmBWvLEdCDCVGmqjBMZXJjMiAEAAAAJHXOSQQAAAAFAAAAAwAAABQAAAAIAAAAiQAAAAEAAAAAAAAAAADgPwAAAAAAABhAAAAAAACAb0AAAAAABikP9PzwAVK8YDCIHPRiDz0pJyhkRMvct7bXeNRlYFFugQY/EJe1MlGUGoD2zJvj8MoqnW/k71pUcqx6hd38jK7unA==",
    expected:
      "R6/MNwqQF1oxphOjhZmdppo2aRoX1Ikonnk0sNYVN9aUtKehnvT47fYeYl+ErWdTpgVryxHQgwlRpqowUrxgMIgc9GIPPSknKGREy9y3ttd41GVgUW6BBj8Ql7UyUZQagPbMm+Pwyiqdb+TvWlRyrHqF3fyMru6c",
  },
];

test("decodes as imagecodecs does", async () => {
  for (const { shape, dtype, encoded, expected } of CASES) {
    const decoded = lercChunkArray(
      DATA_TYPES[dtype],
      [1, ...shape],
      await decodeLerc(fromBase64(encoded)),
    );
    const bytes = fromBase64(expected);
    if (dtype === "float64") {
      expect(decoded).toEqual(
        Float32Array.from(new Float64Array(bytes.buffer)),
      );
    } else {
      expect(
        new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength),
      ).toEqual(bytes);
    }
  }
});

test("resolves a float64 array, shown as float32", () => {
  expect(() =>
    parseCodecChainSpec(
      [{ name: "imagecodecs_lerc" }],
      { dataType: DataType.FLOAT32, chunkShape: [2, 2] },
      true,
    ),
  ).not.toThrow();
});

test("rejects uint64 arrays", () => {
  expect(() =>
    parseCodecChainSpec([{ name: "imagecodecs_lerc" }], {
      dataType: DataType.UINT64,
      chunkShape: [2, 2],
    }),
  ).toThrow(/LERC has no uint64 values/);
});

test("rejects values of another data type", async () => {
  const uint16 = CASES.find((c) => c.dtype === "uint16")!;
  const decoded = await decodeLerc(fromBase64(uint16.encoded));
  expect(() => lercChunkArray(DataType.UINT8, uint16.shape, decoded)).toThrow(
    /LERC blob of U16 values does not match data type uint8/,
  );
});

test("rejects a blob that does not fill the chunk", async () => {
  const uint8 = CASES.find((c) => c.dtype === "uint8")!;
  const decoded = await decodeLerc(fromBase64(uint8.encoded));
  expect(() => lercChunkArray(DataType.UINT8, [2, 2], decoded)).toThrow(
    /LERC blob of shape \[12, 16\] does not fill a chunk of shape \[2, 2\]/,
  );
});

test("rejects bands in place of values per pixel, as imagecodecs does", async () => {
  const bands = CASES.find((c) => c.name === "3 bands")!;
  const decoded = await decodeLerc(fromBase64(bands.encoded));
  expect(() => lercChunkArray(DataType.UINT8, [4, 5, 3], decoded)).toThrow(
    /LERC blob of shape \[3, 4, 5\] does not fill a chunk of shape \[4, 5, 3\]/,
  );
});

test("rejects a stream that is not LERC", async () => {
  await expect(decodeLerc(new Uint8Array(64))).rejects.toThrow();
});
