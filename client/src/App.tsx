import { Route, Switch } from "wouter";
import Welcome from "@/pages/Welcome";
import Signup from "@/pages/Signup";
import Login from "@/pages/Login";
import Setup from "@/pages/Setup";
import Admin from "@/pages/Admin";
import Book from "@/pages/Book";
import Lookup from "@/pages/Lookup";
import PayResult from "@/pages/PayResult";
import VoiceSettings from "@/pages/VoiceSettings";
import VoiceCheck from "@/pages/VoiceCheck";
import Staff from "@/pages/Staff";
import StaffJoin from "@/pages/StaffJoin";
import TicketPass from "@/pages/TicketPass";
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
      <Route path="/voice" component={VoiceSettings} />
      <Route path="/voice-check" component={VoiceCheck} />
      <Route path="/staff/join" component={StaffJoin} />
      <Route path="/staff" component={Staff} />
      <Route path="/t/:token">{(params) => <TicketPass token={params.token} />}</Route>
      <Route><Layout title="404"><p>Not found</p></Layout></Route>
    </Switch>
  );
}
