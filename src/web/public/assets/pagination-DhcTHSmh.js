import{z as d,ae as f,V as e,S as b,l as g,m as N,j as k,k as C,c as r,t as y}from"./index-BvKhg4dq.js";import{C as S}from"./chevron-right-CSpbl2kK.js";/**
 * @license lucide-react v0.469.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const z=d("ChevronFirst",[["path",{d:"m17 18-6-6 6-6",key:"1yerx2"}],["path",{d:"M7 6v12",key:"1p53r6"}]]);/**
 * @license lucide-react v0.469.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const L=d("ChevronLast",[["path",{d:"m7 18 6-6-6-6",key:"lwmzdw"}],["path",{d:"M17 6v12",key:"1o0aio"}]]);/**
 * @license lucide-react v0.469.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const M=d("ChevronLeft",[["path",{d:"m15 18-6-6 6-6",key:"1wnfg3"}]]);function T({page:a,totalPages:c,totalRows:s,perPage:n,perPageOptions:o,onPageChange:l,onPerPageChange:x,className:p}){const{t:i}=f("common"),m=a>1,h=a<c,u=n!==void 0&&o&&o.length>0&&x,v=n?(a-1)*n+1:null,j=n&&s!==void 0?Math.min(a*n,s):null;return e.jsxs("div",{className:y("flex flex-wrap items-center justify-between gap-3 py-2",p),role:"navigation","aria-label":i("pagination.label"),children:[e.jsxs("div",{className:"flex items-center gap-2 text-sm text-text-dim",children:[u&&e.jsxs("div",{className:"hidden sm:flex items-center gap-2",children:[e.jsx("span",{children:i("pagination.perPage")}),e.jsxs(b,{value:String(n),onValueChange:t=>x?.(Number(t)),children:[e.jsx(g,{className:"h-8 w-[80px]",children:e.jsx(N,{})}),e.jsx(k,{children:o.map(t=>e.jsx(C,{value:String(t),children:t},t))})]})]}),s!==void 0&&v!==null&&j!==null&&e.jsx("span",{"aria-live":"polite",children:i("pagination.range",{from:s===0?0:v,to:j,total:s})})]}),e.jsxs("div",{className:"flex items-center gap-1",children:[e.jsx(r,{variant:"ghost",size:"icon","aria-label":i("pagination.firstPage"),disabled:!m,onClick:()=>l(1),className:"hidden sm:inline-flex",children:e.jsx(z,{})}),e.jsx(r,{variant:"ghost",size:"icon","aria-label":i("actions.previous"),disabled:!m,onClick:()=>l(a-1),children:e.jsx(M,{})}),e.jsx("span",{className:"px-2 text-sm tabular-nums","aria-live":"polite",children:i("pagination.pageOfTotal",{page:a,totalPages:Math.max(1,c)})}),e.jsx(r,{variant:"ghost",size:"icon","aria-label":i("actions.next"),disabled:!h,onClick:()=>l(a+1),children:e.jsx(S,{})}),e.jsx(r,{variant:"ghost",size:"icon","aria-label":i("pagination.lastPage"),disabled:!h,onClick:()=>l(c),className:"hidden sm:inline-flex",children:e.jsx(L,{})})]})]})}T.displayName="Pagination";export{T as P};
//# sourceMappingURL=pagination-DhcTHSmh.js.map
