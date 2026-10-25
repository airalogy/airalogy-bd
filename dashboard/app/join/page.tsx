import LoginForm from "../LoginForm";
import {serverMode} from "../lib/server-auth";
import {redirect} from "next/navigation";
export const dynamic="force-dynamic";
export default function Join(){if(!serverMode())redirect("/");return <LoginForm join/>;}
