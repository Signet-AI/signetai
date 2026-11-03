; benchmark generated from python API
(set-info :status unknown)
(declare-fun agent_scoped () Bool)
(declare-fun has_field () Bool)
(declare-fun has_key () Bool)
(declare-fun token () Int)
(declare-fun daemon_default () Int)
(declare-fun key_inferred () Int)
(declare-fun request_field () Int)
(assert
 agent_scoped)
(assert
 (not has_field))
(assert
 (not has_key))
(assert
 (let ((?x538 (ite (or has_field has_key) (ite has_field request_field key_inferred) (ite agent_scoped token daemon_default))))
(let (($x582 (= ?x538 token)))
(not $x582))))
(check-sat)
