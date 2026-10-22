import { Route, Switch } from "wouter";
import Welcome from "@/pages/Welcome";
import Signup from "@/pages/Signup";
import Login from "@/pages/Login";
import Setup from "@/pages/Setup";
import Admin from "@/pages/Admin";
import Book from "@/pages/Book";
import Lookup from "@/pages/Lookup";
import PayResult from "@/pages/PayResult";
import { Layout } from "@/components/Layout";

export default function App() {
  return (
    <Switch>
      <Route path="/" component={Welcome} />
      <Route path="/signup" component={Signup} />
      <Route path="/login" component={Login} />
      <Route path="/setup" component={Setup} />
      <Route path="/admin" component={Admin} />
      <Route path="/book/:slug">{(params) => <Book slug={params.slug} />}</Route>
      <Route path="/lookup" component={Lookup} />
      <Route path="/pay/result" component={PayResult} />
      <Route><Layout title="404"><p>Not found</p></Layout></Route>
    </Switch>
  );
}
