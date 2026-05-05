import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
const tr={en:{tabs:['Recipes','Products','Week menu','Grocery list','Shopping cart']},nl:{tabs:['Recepten','Producten','Weekmenu','Boodschappenlijst','Winkelmand']}};
function App(){const [tab,setTab]=useState(0);const [lang,setLang]=useState('nl');const [dark,setDark]=useState(false);const [token,setToken]=useState(localStorage.getItem('t')||'');const [recipeUrl,setRecipeUrl]=useState('');const [recipes,setRecipes]=useState([]);const [day,setDay]=useState('monday');const [persons,setPersons]=useState(4);const [recipeId,setRecipeId]=useState('');const [list,setList]=useState([]);
useEffect(()=>{document.body.className=dark?'dark':''},[dark]);
const api=async(p,m='GET',b)=>{let r=await fetch('http://localhost:8000'+p,{method:m,headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:b?JSON.stringify(b):undefined});return r.json()};
const login=async()=>{let email=prompt('email');let password=prompt('password');let x=await api('/auth/register','POST',{email,password}); if(x.detail){x=await api('/auth/login','POST',{email,password});} setToken(x.access_token);localStorage.setItem('t',x.access_token)};
const importRecipe=async()=>{await api('/recipes/import','POST',{url:recipeUrl}); loadRecipes();};
const loadRecipes=async()=>setRecipes(await api('/recipes'));
const addWeek=async()=>{await api('/weekplan','POST',{day,recipe_id:Number(recipeId),persons:Number(persons)})};
const gen=async()=>{const d=await api('/shopping-list');setList(d.items||[])};
return <div><h1>Boodschappen</h1><button onClick={()=>setLang(lang==='nl'?'en':'nl')}>{lang}</button><button onClick={()=>setDark(!dark)}>🌓</button><button onClick={login}>Login</button><div className='tabs'>{tr[lang].tabs.map((t,i)=><button key={i} onClick={()=>setTab(i)}>{t}</button>)}</div>
{tab===0&&<div><input value={recipeUrl} onChange={e=>setRecipeUrl(e.target.value)} placeholder='AH recipe URL'/><button onClick={importRecipe}>Import</button><button onClick={loadRecipes}>Load</button>{recipes.map(r=><div key={r.id}><b>{r.name}</b> ({r.ingredients.length})</div>)}</div>}
{tab===1&&<p>Import AH product URL via API /products/import</p>}
{tab===2&&<div><select onChange={e=>setRecipeId(e.target.value)}>{recipes.map(r=><option value={r.id} key={r.id}>{r.name}</option>)}</select><input value={day} onChange={e=>setDay(e.target.value)}/><input type='number' value={persons} onChange={e=>setPersons(e.target.value)}/><button onClick={addWeek}>Add</button></div>}
{tab===3&&<div><button onClick={gen}>Generate</button>{list.map((i,idx)=><div key={idx}>{i.quantity} {i.unit} {i.name}</div>)}</div>}
{tab===4&&<p>Future: AH add-multiple link export.</p>}
</div>}
createRoot(document.getElementById('root')).render(<App/>);
