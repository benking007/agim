import{y as d,ad as f,U as i,S as b,l as g,m as N,j as k,k as y,c as r,s as C}from"./index-Dhn5N1CU.js";import{C as S}from"./chevron-right-kt-CPuJW.js";/**
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
 */const M=d("ChevronLeft",[["path",{d:"m15 18-6-6 6-6",key:"1wnfg3"}]]);function T({page:a,totalPages:c,totalRows:n,perPage:s,perPageOptions:o,onPageChange:l,onPerPageChange:x,className:p}){const{t:e}=f("common"),m=a>1,h=a<c,u=s!==void 0&&o&&o.length>0&&x,v=s?(a-1)*s+1:null,j=s&&n!==void 0?Math.min(a*s,n):null;return i.jsxs("div",{className:C("flex flex-wrap items-center justify-between gap-3 py-2",p),role:"navigation","aria-label":e("pagination.label"),children:[i.jsxs("div",{className:"flex items-center gap-2 text-sm text-text-dim",children:[u&&i.jsxs("div",{className:"hidden sm:flex items-center gap-2",children:[i.jsx("span",{children:e("pagination.perPage")}),i.jsxs(b,{value:String(s),onValueChange:t=>x?.(Number(t)),children:[i.jsx(g,{className:"h-8 w-[80px]",children:i.jsx(N,{})}),i.jsx(k,{children:o.map(t=>i.jsx(y,{value:String(t),children:t},t))})]})]}),n!==void 0&&v!==null&&j!==null&&i.jsx("span",{"aria-live":"polite",children:e("pagination.range",{from:n===0?0:v,to:j,total:n})})]}),i.jsxs("div",{className:"flex items-center gap-1",children:[i.jsx(r,{variant:"ghost",size:"icon","aria-label":e("pagination.firstPage"),disabled:!m,onClick:()=>l(1),className:"hidden sm:inline-flex",children:i.jsx(z,{})}),i.jsx(r,{variant:"ghost",size:"icon","aria-label":e("actions.previous"),disabled:!m,onClick:()=>l(a-1),children:i.jsx(M,{})}),i.jsx("span",{className:"px-2 text-sm tabular-nums","aria-live":"polite",children:e("pagination.pageOfTotal",{page:a,totalPages:Math.max(1,c)})}),i.jsx(r,{variant:"ghost",size:"icon","aria-label":e("actions.next"),disabled:!h,onClick:()=>l(a+1),children:i.jsx(S,{})}),i.jsx(r,{variant:"ghost",size:"icon","aria-label":e("pagination.lastPage"),disabled:!h,onClick:()=>l(c),className:"hidden sm:inline-flex",children:i.jsx(L,{})})]})]})}T.displayName="Pagination";export{T as P};
//# sourceMappingURL=pagination-Buva7uHJ.js.map
